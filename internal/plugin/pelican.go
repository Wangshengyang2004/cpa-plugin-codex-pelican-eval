package plugin

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	pelicanHistoryLimit = 20
	pelicanMaxRuns      = 5
	// Larger drawings are kept out of the state file; the page shows the error instead.
	pelicanMaxSVGBytes = 256 << 10
)

// Simon Willison's benchmark prompt, sent verbatim so results stay comparable.
const pelicanPrompt = "Generate an SVG of a pelican riding a bicycle"

var (
	pelicanResults = map[string][]pelicanResult{}
	pelicanRunning = map[string]*pelicanProgress{}
)

type pelicanResult struct {
	Skipped         bool      `json:"skipped,omitempty"`
	Time            time.Time `json:"time"`
	Model           string    `json:"model"`
	Effort          string    `json:"effort"`
	OK              bool      `json:"ok"`
	SVG             string    `json:"svg,omitempty"`
	Answer          string    `json:"answer,omitempty"`
	Error           string    `json:"error,omitempty"`
	Rating          string    `json:"rating,omitempty"`
	InputTokens     int64     `json:"input_tokens"`
	OutputTokens    int64     `json:"output_tokens"`
	ReasoningTokens int64     `json:"reasoning_tokens"`
	DurationMS      int64     `json:"duration_ms"`
}

type pelicanProgress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

type pelicanRunRequest struct {
	ModelCatalog map[string][]string `json:"model_catalog,omitempty"`
	AuthIDs      []string            `json:"auth_ids"`
	All          bool                `json:"all"`
	Model        string              `json:"model"`
	Effort       string              `json:"effort"`
	Runs         int                 `json:"runs"`
}

func pelicanRunResponse(body []byte) managementResponse {
	var req pelicanRunRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return jsonError(http.StatusBadRequest, "请求格式错误："+err.Error())
	}
	req.Model = strings.TrimSpace(req.Model)
	req.Effort = strings.TrimSpace(req.Effort)
	if !validModelName(req.Model, true) {
		return jsonError(http.StatusBadRequest, "请选择模型")
	}
	req.Runs = min(max(req.Runs, 1), pelicanMaxRuns)
	auths, err := selectedCredentials(req.AuthIDs, req.All)
	if err != nil {
		return jsonError(http.StatusBadGateway, err.Error())
	}
	if len(auths) == 0 {
		return jsonError(http.StatusBadRequest, "没有可测试的已启用凭证")
	}
	mu.Lock()
	defer mu.Unlock()
	if quiescing {
		return jsonError(http.StatusServiceUnavailable, "插件正在停止，请稍后重试")
	}
	summary := runSummary{}
	for _, auth := range auths {
		id := auth.ID
		if pelicanRunning[id] != nil {
			summary.Busy++
			continue
		}
		if known, supported := credentialSupportsModel(req.ModelCatalog, id, req.Model); known && !supported {
			appendPelicanResult(id, pelicanResult{Time: time.Now().UTC(), Model: req.Model, Effort: req.Effort, Skipped: true, Error: unsupportedModelMessage})
			summary.Skipped++
			continue
		} else if !known {
			summary.Unchecked++
		}
		pelicanRunning[id] = &pelicanProgress{Total: req.Runs}
		summary.Started++
		tasks.Add(1)
		go runPelican(auth, req.Model, req.Effort, req.Runs)
	}
	if summary.Skipped > 0 {
		_ = saveStateLocked()
	}
	return jsonResponse(http.StatusOK, summary)
}

// Each credential runs serially; different credentials run in parallel.
func runPelican(auth credential, model, effort string, runs int) {
	id := auth.ID
	defer tasks.Done()
	defer func() {
		mu.Lock()
		delete(pelicanRunning, id)
		mu.Unlock()
	}()
	for range runs {
		mu.Lock()
		stopping := quiescing
		mu.Unlock()
		if stopping {
			return
		}
		r := evaluatePelican(auth, model, effort)
		mu.Lock()
		appendPelicanResult(id, r)
		pelicanRunning[id].Done++
		_ = saveStateLocked()
		mu.Unlock()
	}
}

func evaluatePelican(auth credential, model, effort string) pelicanResult {
	r := pelicanResult{Time: time.Now().UTC(), Model: model, Effort: effort}
	payload := map[string]any{"model": model, "input": pelicanPrompt, "stream": false}
	if effort != "" && effort != "none" {
		payload["reasoning"] = map[string]string{"effort": effort}
	}
	start := time.Now()
	out, _, err := executeModel(auth, model, payload)
	r.DurationMS = time.Since(start).Milliseconds()
	r.InputTokens, r.OutputTokens, r.ReasoningTokens = out.InputTokens, out.OutputTokens, out.ReasoningTokens
	if err != nil {
		r.Error = truncate(err.Error(), 500)
		return r
	}
	svg, err := extractSVG(out.Answer)
	if err != nil {
		r.Error = err.Error()
		r.Answer = truncate(out.Answer, 4000)
		return r
	}
	r.SVG, r.OK = svg, true
	return r
}

// extractSVG returns the first complete, well-formed <svg> element in text.
// Models usually wrap it in prose or a code fence; nested <svg> elements count
// toward nesting so the outer element is not cut at an inner closing tag.
func extractSVG(text string) (string, error) {
	lower := strings.ToLower(text)
	start := strings.Index(lower, "<svg")
	if start < 0 {
		return "", errors.New("回答中没有 SVG")
	}
	depth := 0
	for i := start; i < len(lower); {
		open := strings.Index(lower[i:], "<svg")
		closing := strings.Index(lower[i:], "</svg>")
		if closing < 0 {
			return "", errors.New("SVG 不完整：缺少 </svg>，可能被截断")
		}
		if open >= 0 && open < closing {
			depth++
			i += open + len("<svg")
			continue
		}
		depth--
		i += closing + len("</svg>")
		if depth == 0 {
			svg := text[start:i]
			if len(svg) > pelicanMaxSVGBytes {
				return "", fmt.Errorf("SVG 过大（%d KB），超过 %d KB 上限", len(svg)>>10, pelicanMaxSVGBytes>>10)
			}
			if err := wellFormed(svg); err != nil {
				return "", fmt.Errorf("SVG 无法解析：%w", err)
			}
			return svg, nil
		}
	}
	return "", errors.New("SVG 不完整：标签未闭合")
}

func wellFormed(svg string) error {
	decoder := xml.NewDecoder(strings.NewReader(svg))
	decoder.Entity = xml.HTMLEntity
	for {
		if _, err := decoder.Token(); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func rateResponse(body []byte) managementResponse {
	var req struct {
		AuthID string    `json:"auth_id"`
		Time   time.Time `json:"time"`
		Rating string    `json:"rating"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return jsonError(http.StatusBadRequest, "请求格式错误："+err.Error())
	}
	if req.Rating != "" && req.Rating != "good" && req.Rating != "bad" {
		return jsonError(http.StatusBadRequest, "评价只能是 good、bad 或空")
	}
	mu.Lock()
	defer mu.Unlock()
	history := pelicanResults[req.AuthID]
	for i := range history {
		if history[i].Time.Equal(req.Time) && history[i].OK {
			previous := history[i].Rating
			history[i].Rating = req.Rating
			if err := saveStateLocked(); err != nil {
				history[i].Rating = previous
				return jsonError(http.StatusInternalServerError, "保存评价失败："+err.Error())
			}
			return jsonResponse(http.StatusOK, map[string]string{"rating": req.Rating})
		}
	}
	return jsonError(http.StatusNotFound, "找不到这幅画")
}

func appendPelicanResult(id string, r pelicanResult) {
	history := append(pelicanResults[id], r)
	pelicanResults[id] = history[max(len(history)-pelicanHistoryLimit, 0):]
}
