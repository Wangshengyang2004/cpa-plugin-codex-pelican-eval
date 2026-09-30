"use strict";

const DEFAULT_EFFORT = "medium";
const DEFAULT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

const pelicanExpanded = new Set();
const pelicanSelected = new Set();
const sourceOpen = new Set();

const pelicanPrefs = () => stored(PREF_STORE) || {};
const pelicanSavePrefs = () => store(PREF_STORE, { model: $("model").value, effort: $("effort").value, runs: pelicanRuns() });
const pelicanRuns = () => boundedInput("runs", 1, 5);

const scopeMatch = (r) => r.model === $("model").value && (r.effort || "none") === $("effort").value;
const kind = (r) => (r.skipped ? "skip" : r.ok ? "ok" : r.answer ? "bad" : "err");
const VERDICT = { ok: "得到 SVG", bad: "无有效 SVG", err: "出错", skip: "已跳过" };
const MARK = { ok: "circle-check", bad: "circle-x", err: "circle-alert", skip: "ban" };
const verdict = (r) => `<span class="verdict ${kind(r)}">${icon(MARK[kind(r)])}${VERDICT[kind(r)]}</span>`;
const recordKey = (id, r) => JSON.stringify([id, r.time]);
const RATING_LABEL = { good: "画得好", bad: "画得差" };

// Hosts render data: images without scripts, so a model's SVG cannot run code
// here. Images need an SVG namespace to decode, which models sometimes omit.
function svgDataURI(svg) {
  const markup = /^<svg\b[^>]*\bxmlns\s*=/i.test(svg) ? svg : svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
}

function drawing(r, size, label) {
  if (r?.ok && r.svg) {
    return `<img class="drawing ${size}" src="${esc(svgDataURI(r.svg))}" alt="${esc(label)}" loading="lazy" decoding="async">`;
  }
  const symbol = r ? MARK[kind(r)] : "bike";
  return `<span class="drawing ${size} placeholder" role="img" aria-label="${esc(label)}">${icon(symbol)}</span>`;
}

const ratingBadge = (r) => r.rating ? `<span class="rating-badge ${r.rating}" title="${RATING_LABEL[r.rating]}">${icon(r.rating === "good" ? "thumbs-up" : "thumbs-down")}</span>` : "";

function thumbButton(a, r, size) {
  const label = `${fmtTime(r.time)} ${modelName(r)} ${VERDICT[kind(r)]}${r.rating ? " · " + RATING_LABEL[r.rating] : ""}`;
  return `<button class="thumb ${size} ${scopeMatch(r) ? "" : "dim"}" type="button" data-view="${esc(recordKey(a.id, r))}" title="${esc(label)}" aria-label="${esc("查看 " + label)}">${drawing(r, size, label)}${ratingBadge(r)}</button>`;
}

function pelicanHistory(a, r) {
  const text = r.error ? `<pre class="answer-content error">${esc(r.error)}</pre>` : "";
  return historyCard(r, `<div class="history-drawing">${thumbButton(a, r, "medium")}<div class="history-side">${verdict(r)}${text}${r.ok ? ratingButtons(a, r) : ""}</div></div>`);
}

function ratingButtons(a, r) {
  const key = esc(recordKey(a.id, r));
  const button = (value, symbol) => `<button class="btn ghost rate ${r.rating === value ? "active " + value : ""}" type="button" data-rate="${key}" data-value="${r.rating === value ? "" : value}" aria-pressed="${r.rating === value}" title="${RATING_LABEL[value]}" aria-label="${RATING_LABEL[value]}" ${pending ? "disabled" : ""}>${icon(symbol)}</button>`;
  return `<div class="rate-group">${button("good", "thumbs-up")}${button("bad", "thumbs-down")}</div>`;
}

function renderPelicanRow(a) {
  const results = a.results;
  const last = results[results.length - 1];
  const open = pelicanExpanded.has(a.id);
  const latest = last
    ? `<div class="latest-drawing">${thumbButton(a, last, "small")}<div class="latest-copy"><div class="latest-top">${verdict(last)}${ratingBadge(last)}</div>${modelMeta(last)}<div class="metrics">${last.skipped ? "" : metrics(last)}</div></div></div>`
    : `<span class="none">尚未测试</span>`;
  const strip = results.length
    ? results.slice(-8).map((r) => thumbButton(a, r, "tiny")).join("")
    : `<span class="none">—</span>`;
  const action = a.running
    ? `<button class="btn ghost" type="button" disabled>${icon("loader-circle", "spin")}绘制中 <span class="mono">${a.running.done}/${a.running.total}</span></button>`
    : `<button class="btn" type="button" data-run="${esc(a.id)}" ${pending || !$("model").value || !availableCredential(a) ? "disabled" : ""}>${icon("play")}测试</button>`;

  return `<div class="row ${open ? "open" : ""}">
    <div class="list-row row-main" data-row="${esc(a.id)}">
      <input type="checkbox" data-pelican-select="${esc(a.id)}" aria-label="选择此凭证" ${pelicanSelected.has(a.id) ? "checked" : ""} ${pending || !$("model").value || !availableCredential(a) ? "disabled" : ""}>
      ${credentialView(a, open)}
      <div class="latest">${latest}</div>
      <div class="strip">${strip}</div>
      <div class="action">${action}</div>
    </div>
    ${open ? historyPanel([...results].reverse().map((r) => pelicanHistory(a, r)).join("")) : ""}
  </div>`;
}

function findRecord(key) {
  const [id, time] = JSON.parse(key);
  const a = credentials.find((c) => c.id === id);
  return { a, r: a?.results.find((r) => r.time === time) };
}

function showDrawing(key) {
  const { a, r } = findRecord(key);
  if (!a || !r) return;
  const dialog = $("pelican-detail");
  dialog.dataset.record = key;
  const source = sourceOpen.has(key);
  const body = r.ok
    ? `<div class="drawing-stage">${drawing(r, "large", "鹈鹕画作")}</div>
       <div class="detail-actions">${ratingButtons(a, r)}<button class="btn ghost" type="button" data-source="${esc(key)}" aria-expanded="${source}">${icon("code")}${source ? "隐藏" : "查看"} SVG 源码 <span class="meta mono">${fmtNum(r.svg.length)} B</span></button></div>
       ${source ? `<pre class="svg-source mono">${esc(r.svg)}</pre>` : ""}`
    : `<pre class="answer-content error expanded-text">${esc(r.error || "")}</pre>${r.answer ? `<div class="history-title">模型回答</div><pre class="svg-source">${esc(r.answer)}</pre>` : ""}`;
  $("pelican-detail-title").textContent = a.email || a.name;
  $("pelican-detail-body").innerHTML = `<div class="result-meta detail-meta">${verdict(r)}${metric("calendar", "测试时间", fmtTime(r.time))}${modelMeta(r)}</div><div class="metrics">${r.skipped ? "" : metrics(r)}</div>${body}`;
  if (!dialog.open) dialog.showModal();
}

function runPelican(body) {
  if (!$("toolbar").reportValidity()) return;
  pelicanSavePrefs();
  return update("/run", { method: "POST", body: { ...body, model: $("model").value, effort: $("effort").value, runs: pelicanRuns() } }, "开始测试失败");
}

async function ratePelican(key, rating) {
  const { a, r } = findRecord(key);
  if (!a || !r) return;
  const dialog = $("pelican-detail");
  const reopen = dialog.open && dialog.dataset.record === key;
  await update("/rate", { method: "POST", body: { auth_id: a.id, time: r.time, rating } }, "保存评价失败");
  if (reopen) showDrawing(key);
}

function renderPelican() {
  renderSelection("", pelicanSelected, "测试");
  $("clear").disabled = pending || credentials.every((a) => !a.results.length);
  renderList("", renderPelicanRow);
  const dialog = $("pelican-detail");
  if (dialog.open && !findRecord(dialog.dataset.record).r) dialog.close();
}

function initializePelican() {
  const saved = pelicanPrefs();
  fillSelect("effort", DEFAULT_EFFORTS, saved.effort, DEFAULT_EFFORT);
  $("effort").title = "none：不发送推理参数，由 CPA 处理；其他强度由 CPA 或上游验证";
  $("runs").value = saved.runs || 1;
  $("runs").value = pelicanRuns();

  $("model").addEventListener("change", () => { pelicanSavePrefs(); render(); });
  $("effort").addEventListener("change", () => { pelicanSavePrefs(); render(); });
  $("runs").addEventListener("change", () => { $("runs").value = pelicanRuns(); pelicanSavePrefs(); });
  $("pelican-detail-close").addEventListener("click", () => $("pelican-detail").close());

  const onClick = (e) => {
    if (e.target.closest("[data-pelican-select]")) return;
    const rate = e.target.closest("[data-rate]");
    if (rate) return ratePelican(rate.dataset.rate, rate.dataset.value);
    const view = e.target.closest("[data-view]");
    if (view) return showDrawing(view.dataset.view);
    const toggleSource = e.target.closest("[data-source]");
    if (toggleSource) {
      const key = toggleSource.dataset.source;
      sourceOpen.has(key) ? sourceOpen.delete(key) : sourceOpen.add(key);
      return showDrawing(key);
    }
    const btn = e.target.closest("[data-run]");
    if (btn) return runPelican({ auth_ids: [btn.dataset.run] });
    const row = e.target.closest("[data-row]");
    if (!row) return;
    const id = row.dataset.row;
    pelicanExpanded.has(id) ? pelicanExpanded.delete(id) : pelicanExpanded.add(id);
    render();
  };
  $("rows").addEventListener("click", onClick);
  $("pelican-detail-body").addEventListener("click", onClick);
}
