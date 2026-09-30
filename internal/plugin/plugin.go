// Package plugin implements the pelican SVG drawing test for CPA credentials.
package plugin

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"strings"
	"sync"
)

const (
	pluginID      = "cpa-codex-pelican-eval"
	pluginVersion = "0.1.0"
	ABIVersion    = 1
	schemaVersion = 6
	// CPA rejects plugins without a repository URL.
	repositoryURL  = "https://github.com/Wangshengyang2004/cpa-plugin-codex-pelican-eval"
	managementBase = "/v0/management/plugins/" + pluginID
	uiPath         = "/v0/resource/plugins/" + pluginID + "/ui"
)

var hostCall func(method string, payload any) (json.RawMessage, error)

func SetHostCall(call func(string, any) (json.RawMessage, error)) {
	hostCall = call
}

//go:embed web/ui.html
var uiTemplate string

//go:embed web/style.css
var uiStyles string

//go:embed web/pelican.css
var pelicanStyles string

//go:embed web/credentials.js
var credentialScript string

//go:embed web/app.js
var appScript string

//go:embed web/catalog.js
var catalogScript string

//go:embed web/components.js
var componentsScript string

//go:embed web/pelican.js
var pelicanScript string

var uiHTML = []byte(strings.NewReplacer(
	"/*APP_STYLES*/", uiStyles+"\n"+pelicanStyles,
	"<!--PLUGIN_VERSION-->", pluginVersion,
	"<!--PELICAN_PROMPT-->", html.EscapeString(pelicanPrompt),
	"/*CREDENTIALS_SCRIPT*/", credentialScript,
	"/*CATALOG_SCRIPT*/", catalogScript,
	"/*COMPONENTS_SCRIPT*/", componentsScript,
	"/*PELICAN_SCRIPT*/", pelicanScript,
	"/*APP_SCRIPT*/", appScript,
).Replace(uiTemplate))

// Lucide "bike" icon. Hosts render it in an img element, so the stroke color is fixed.
const logoSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#72787c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><style>@media (prefers-color-scheme: dark) { :root { stroke: #9c9d9b; } }</style><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`

var (
	mu        sync.Mutex
	tasks     sync.WaitGroup
	quiescing bool
)

type Envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *EnvelopeError  `json:"error,omitempty"`
}

type EnvelopeError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

func (e *EnvelopeError) Error() string { return e.Code + ": " + e.Message }

type managementRequest struct {
	Method string `json:"Method"`
	Path   string `json:"Path"`
	Body   []byte `json:"Body"`
}

type managementResponse struct {
	StatusCode int         `json:"StatusCode"`
	Headers    http.Header `json:"Headers,omitempty"`
	Body       []byte      `json:"Body,omitempty"`
}

func HandleMethod(method string, request []byte) (response []byte) {
	defer func() {
		if recovered := recover(); recovered != nil {
			response = errorEnvelope("plugin_panic", fmt.Sprint(recovered), http.StatusInternalServerError)
		}
	}()
	switch method {
	case "plugin.register", "plugin.reconfigure":
		loadState()
		mu.Lock()
		quiescing = false
		mu.Unlock()
		return okEnvelope(map[string]any{
			"schema_version": schemaVersion,
			"metadata": map[string]any{
				"Name":             pluginID,
				"Version":          pluginVersion,
				"Author":           "Wangshengyang2004",
				"GitHubRepository": repositoryURL,
				"Logo":             "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(logoSVG)),
				"ConfigFields":     []any{},
			},
			"capabilities": map[string]bool{"management_api": true},
		})
	case "management.register":
		return okEnvelope(map[string]any{
			"routes": []map[string]string{
				{"Method": http.MethodPost, "Path": managementBase + "/credentials/sync", "Description": "Sync configured credential identities"},
				{"Method": http.MethodGet, "Path": managementBase + "/state", "Description": "View pelican drawings"},
				{"Method": http.MethodPost, "Path": managementBase + "/run", "Description": "Run the pelican SVG test on credentials"},
				{"Method": http.MethodPost, "Path": managementBase + "/rate", "Description": "Rate a pelican drawing"},
				{"Method": http.MethodDelete, "Path": managementBase + "/results", "Description": "Clear pelican test results"},
			},
			"resources": []map[string]string{
				{"Path": uiPath, "Menu": "Codex 鹈鹕测试", "Description": "让 CPA 凭证画一只骑自行车的鹈鹕，并排对比 SVG"},
			},
		})
	case "management.handle":
		var req managementRequest
		if err := json.Unmarshal(request, &req); err != nil {
			return errorEnvelope("invalid_request", err.Error(), http.StatusBadRequest)
		}
		return okEnvelope(handleManagement(req))
	case "plugin.quiesce":
		Quiesce()
		return okEnvelope(map[string]any{})
	default:
		return errorEnvelope("unknown_method", "Unsupported plugin method: "+method, http.StatusNotFound)
	}
}

func handleManagement(req managementRequest) managementResponse {
	path := strings.TrimRight(req.Path, "/")
	switch {
	case req.Method == http.MethodGet && path == uiPath:
		return managementResponse{
			StatusCode: http.StatusOK,
			Headers: http.Header{
				"Content-Type":           {"text/html; charset=utf-8"},
				"Cache-Control":          {"no-store"},
				"X-Content-Type-Options": {"nosniff"},
				// Drawings are shown only as data: images, which never run scripts.
				"Content-Security-Policy": {"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"},
			},
			Body: uiHTML,
		}
	case req.Method == http.MethodPost && path == managementBase+"/credentials/sync":
		return syncCredentialsResponse(req.Body)
	case req.Method == http.MethodGet && path == managementBase+"/state":
		return stateResponse()
	case req.Method == http.MethodPost && path == managementBase+"/run":
		return pelicanRunResponse(req.Body)
	case req.Method == http.MethodPost && path == managementBase+"/rate":
		return rateResponse(req.Body)
	case req.Method == http.MethodDelete && path == managementBase+"/results":
		return clearHistoryResponse()
	default:
		return jsonError(http.StatusNotFound, "Route not found: "+req.Method+" "+req.Path)
	}
}

func stateResponse() managementResponse {
	auths, err := credentials()
	if err != nil {
		return jsonError(http.StatusBadGateway, err.Error())
	}
	// Host calls must stay outside the results lock.
	for i := range auths {
		if auths[i].Source == credentialSourceFile && auths[i].Provider == "codex" {
			auths[i].PlanType = authPlanType(auths[i])
		}
	}
	mu.Lock()
	defer mu.Unlock()
	views := make([]credentialView, 0, len(auths))
	for _, auth := range auths {
		view := credentialView{credential: auth, Results: pelicanResults[auth.ID], Running: pelicanRunning[auth.ID]}
		if view.Results == nil {
			view.Results = []pelicanResult{}
		}
		views = append(views, view)
	}
	return jsonResponse(http.StatusOK, map[string]any{"auths": views, "storage_error": storageError})
}

func Quiesce() {
	mu.Lock()
	quiescing = true
	mu.Unlock()
	tasks.Wait()
}

func truncate(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}

func okEnvelope(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return errorEnvelope("encode_failed", err.Error(), http.StatusInternalServerError)
	}
	data, _ := json.Marshal(Envelope{OK: true, Result: raw})
	return data
}

func errorEnvelope(code, message string, status int) []byte {
	data, _ := json.Marshal(Envelope{Error: &EnvelopeError{Code: code, Message: message, HTTPStatus: status}})
	return data
}

func jsonResponse(status int, v any) managementResponse {
	body, err := json.Marshal(v)
	if err != nil {
		return jsonError(http.StatusInternalServerError, "编码响应失败："+err.Error())
	}
	return managementResponse{StatusCode: status, Headers: http.Header{"Content-Type": {"application/json; charset=utf-8"}}, Body: body}
}

func jsonError(status int, message string) managementResponse {
	return jsonResponse(status, map[string]any{"error": map[string]string{"message": message}})
}
