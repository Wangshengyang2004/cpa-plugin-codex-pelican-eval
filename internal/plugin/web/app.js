"use strict";
const BASE = "/v0/management/plugins/cpa-codex-pelican-eval";
const KEY_STORE = "cpa-codex-pelican-eval.key";
const PREF_STORE = "cpa-codex-pelican-eval.prefs";
const MASK_STORE = "cpa-codex-pelican-eval.masked";
const DEFAULT_MODEL = "gpt-6-astra";
const HIDDEN_MODEL = (id) => id.toLowerCase().includes("image") || id.toLowerCase().split("/").pop().split("(")[0] === "codex-auto-review";

let key = "";
let credentials = [];
let pollTimer = 0;
let loadError = "";
let loadController = null;
let pending = false;
let storageError = "";
const listMarkup = new Map();

// The CPA management panel keeps its state in same-origin localStorage, optionally obfuscated.
function panelValue(name) {
  try {
    let raw = localStorage.getItem(name);
    if (!raw) return null;
    const prefix = "enc::v1::";
    if (raw.startsWith(prefix)) {
      const secret = new TextEncoder().encode("cli-proxy-api-webui::secure-storage|" + location.host + "|" + navigator.userAgent);
      const bin = atob(raw.slice(prefix.length));
      const bytes = Uint8Array.from(bin, (c, i) => c.charCodeAt(0) ^ secret[i % secret.length]);
      raw = new TextDecoder().decode(bytes);
    }
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function applyTheme() {
  const theme = panelValue("cli-proxy-theme")?.state?.theme;
  const dark = theme === "dark" || (theme !== "white" && theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
function panelKey() {
  const k = panelValue("cli-proxy-auth")?.state?.managementKey;
  return typeof k === "string" ? k.trim() : "";
}

class AuthError extends Error {}

async function api(path, { method = "GET", body, apiKey, signal } = {}) {
  const timeout = AbortSignal.timeout(30000);
  const init = { method, cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Authorization: "Bearer " + (apiKey ?? key) } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let resp, text;
  try {
    resp = await fetch(path, init);
    text = await resp.text();
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(err.name === "TimeoutError" ? "连接超时，请稍后重试。" : "无法连接 CPA，请检查网络后重试。");
  }
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (resp.status === 401 && apiKey === undefined) throw new AuthError("管理密钥无效，请重新输入。");
  if (!resp.ok) {
    const err = data?.error;
    throw new Error(String((typeof err === "string" ? err : err?.message) || text || "HTTP " + resp.status).slice(0, 500));
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("服务器返回了无效数据，请稍后重试。");
  return data;
}

function stored(name) {
  try { return JSON.parse(localStorage.getItem(name)); } catch (_) { return null; }
}
function store(name, value) {
  try { localStorage.setItem(name, JSON.stringify(value)); } catch (_) {}
}
function fillModels() {
  const ids = [...new Set(catalogCache.models?.ids || [])].sort(compareModels);
  fillSelect("model", ids, $("model").value || pelicanPrefs().model, DEFAULT_MODEL);
}
function renderList(prefix, renderRow) {
  const id = prefix + "rows", list = $(id);
  const visible = visibleCredentials(prefix);
  const empty = loadController && !credentials.length ? "正在读取凭证与历史记录…" : "当前类型没有凭证，请切换类型或在 CPA 中添加凭证。";
  const html = visible.length ? visible.map(renderRow).join("") : `<div class="empty">${esc(loadError || empty)}</div>`;
  if (listMarkup.get(id) === html) return;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const selector = focused && [...focused.attributes].filter((a) => a.name.startsWith("data-"))
    .map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join("");
  list.innerHTML = html;
  listMarkup.set(id, html);
  if (selector) list.querySelector(selector)?.focus({ preventScroll: true });
}

function renderRefresh() {
  $("refresh").disabled = pending || !!loadController;
  $("refresh").setAttribute("aria-busy", !!loadController);
}

function render() {
  renderRefresh();
  setNotice("storage-error", storageError);
  renderPelican();
}

function stopPolling() {
  clearTimeout(pollTimer);
  loadController?.abort();
  loadController = null;
  renderRefresh();
}

function stateCredentials(data) {
  const validRecord = (r) => r !== null && typeof r === "object" && !Array.isArray(r);
  if (!Array.isArray(data.auths) || data.auths.some((a) => !a || typeof a.id !== "string" || !a.id.trim() || !Array.isArray(a.results) || !a.results.every(validRecord))) {
    throw new Error("服务器返回的测试记录格式无效。");
  }
  return data.auths;
}

async function load({ refresh = false } = {}) {
  stopPolling();
  const controller = new AbortController();
  loadController = controller;
  render();
  try {
    try {
      await refreshCatalog({ signal: controller.signal, force: refresh });
      if (controller.signal.aborted) return;
      fillModels();
      setNotice("catalog-error", "");
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof AuthError) return showLogin(err.message);
      setNotice("catalog-error", "读取凭证与模型目录失败：" + err.message);
    }
    const data = await api(BASE + "/state", { signal: controller.signal });
    if (controller.signal.aborted) return;
    credentials = stateCredentials(data);
    pruneCredentialCatalog();
    fillCredentialTypes();
    storageError = data.storage_error || "";
    loadError = "";
    setNotice("load-error", "");
    const ids = new Set(credentials.map((a) => a.id));
    const enabled = new Set(credentials.filter((a) => !a.disabled).map((a) => a.id));
    for (const id of pelicanExpanded) if (!ids.has(id)) pelicanExpanded.delete(id);
    for (const id of pelicanSelected) if (!enabled.has(id)) pelicanSelected.delete(id);
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof AuthError) return showLogin(err.message);
    loadError = "读取测试结果失败：" + err.message;
    setNotice("load-error", loadError);
  } finally {
    if (loadController === controller) {
      loadController = null;
      render();
      pollTimer = setTimeout(load, credentials.some((a) => a.running) ? 2500 : 20000);
    }
  }
}

async function update(path, options, errorPrefix) {
  if (pending) return;
  pending = true;
  stopPolling();
  setNotice("flash", "");
  render();
  try {
    if (path.endsWith("/run")) {
      await refreshCatalog();
      fillModels();
      setNotice("catalog-error", "");
      if (!catalogCache.models?.ids.includes(options.body.model)) throw new Error("所选模型已不在模型目录中，请重新选择。");
      options.body.model_catalog = await modelCatalog(options.body.auth_ids || []);
    }
    const response = await api(BASE + path, options);
    if (path.endsWith("/run")) {
      const messages = [`已启动 ${response.started || 0} 个凭证`];
      if (response.skipped) messages.push(`${response.skipped} 个凭证不含所选模型，已跳过`);
      if (response.unchecked) messages.push(`${response.unchecked} 个凭证未能检查模型目录，已交由 CPA 处理`);
      if (response.busy) messages.push(`${response.busy} 个凭证正在测试`);
      setNotice("flash", messages.join("；"), response.unchecked ? "warning" : "info");
    }
  } catch (err) {
    if (err instanceof AuthError) return showLogin(err.message);
    setNotice("flash", errorPrefix + "：" + err.message);
  } finally {
    pending = false;
    if (!$("app").hidden) await load();
  }
}

function showLogin(message) {
  stopPolling();
  key = "";
  try { sessionStorage.removeItem(KEY_STORE); } catch (_) {}
  resetCatalogCache();
  credentials = [];
  loadError = storageError = "";
  pelicanSelected.clear();
  pelicanExpanded.clear();
  for (const id of notices.keys()) setNotice(id, "");
  $("refresh").hidden = true;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  render();
  $("app").hidden = true;
  $("login").hidden = false;
  $("login-error").hidden = !message;
  $("login-error").textContent = message || "";
  $("login-key").focus();
}

async function start() {
  setNotice("flash", "");
  $("login").hidden = true;
  $("app").hidden = false;
  $("refresh").hidden = false;
  const managementKey = key;
  await openCatalogCache(managementKey);
  if (managementKey !== key) return;
  fillModels();
  await load({ refresh: true });
}

function setMasked(masked) {
  document.body.classList.toggle("masked", masked);
  $("mask").setAttribute("aria-pressed", masked);
  const label = masked ? "取消脱敏" : "脱敏";
  $("mask").innerHTML = icon(masked ? "eye" : "eye-off");
  $("mask").setAttribute("aria-label", label);
  $("mask").title = label;
}
const availableCredential = (a) => !a.disabled && !a.running;
const selectedCredentials = (prefix, selection) => visibleCredentials(prefix).filter((a) => selection.has(a.id));
const batchCredentials = (prefix, selection) => {
  const selected = selectedCredentials(prefix, selection);
  return (selected.length ? selected : visibleCredentials(prefix)).filter(availableCredential);
};
function renderSelection(prefix, selection, action) {
  const available = visibleCredentials(prefix).filter(availableCredential);
  const selected = selectedCredentials(prefix, selection);
  const targets = batchCredentials(prefix, selection);
  const button = $(prefix + "run-batch");
  button.innerHTML = `${icon("play")}${action}${selected.length ? "所选" : "全部"} (${targets.length})`;
  button.disabled = pending || !targets.length || !$(prefix + "model").value;
  const checkbox = $(prefix + "select-all");
  checkbox.checked = available.length > 0 && available.every((a) => selection.has(a.id));
  checkbox.indeterminate = selected.length > 0 && !checkbox.checked;
  checkbox.disabled = pending || (!available.length && !selected.length);
}

const credentialType = (a) => a.source + ":" + a.provider;
const credentialTypeLabel = (a) => `${a.source === "ai_providers" ? "AI 提供商" : "认证文件"} · ${a.provider}`;
const visibleCredentials = (prefix) => credentials.filter((a) => $(prefix + "credential-type").value === "all" || credentialType(a) === $(prefix + "credential-type").value);
function fillCredentialTypes() {
  const types = new Map(credentials.map((a) => [credentialType(a), credentialTypeLabel(a)]));
  // Keep the requested default visible even when there are no Codex files.
  types.set("auth_files:codex", "认证文件 · codex");
  const options = [["all", "全部凭证"], ...[...types].sort(([a], [b]) => a.localeCompare(b))];
  fillSelect("credential-type", options, $("credential-type").value, "auth_files:codex");
}

function initializeLayout() {
  $("pelican-credentials").innerHTML = credentialCard("", ["凭证", "最近一幅", "最近 8 幅", ""]);
  $("notifications").innerHTML = ["flash", "load-error", "catalog-error", "storage-error"].map((id) => `<div id="${id}" class="global-flash" role="alert" hidden><span class="notice-symbol" aria-hidden="true"></span><span class="notice-message"></span><button class="notice-close" type="button" title="隐藏提示" aria-label="隐藏提示">${icon("x")}</button></div>`).join("");
}

// Events and initialization.
initializeLayout();
initializePelican();
document.querySelectorAll("[data-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.icon, el.dataset.class); });

for (const id of ["flash", "load-error", "catalog-error", "storage-error"]) {
  $(id).querySelector(".notice-close").addEventListener("click", () => hideNotice(id));
}

$("refresh").addEventListener("click", () => {
  if (pending) return;
  resetCatalogCache();
  load({ refresh: true });
});

applyTheme();
addEventListener("storage", applyTheme);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

setMasked(stored(MASK_STORE) === true);
$("mask").addEventListener("click", () => {
  const masked = !document.body.classList.contains("masked");
  setMasked(masked);
  store(MASK_STORE, masked);
});

$("clear").addEventListener("click", () => {
  $("confirm-clear").returnValue = ""; // Esc keeps the previous returnValue.
  $("confirm-clear").showModal();
});
$("confirm-clear").addEventListener("close", () => {
  if ($("confirm-clear").returnValue !== "confirm") return;
  update("/results", { method: "DELETE" }, "清空历史失败");
});

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  key = $("login-key").value.trim();
  try { sessionStorage.setItem(KEY_STORE, key); } catch (_) {}
  start();
});

$("credential-type").addEventListener("change", () => { pelicanSelected.clear(); render(); });
$("toolbar").addEventListener("submit", (e) => {
  e.preventDefault();
  const ids = batchCredentials("", pelicanSelected).map((a) => a.id);
  if (ids.length) runPelican({ auth_ids: ids });
});
$("select-all").addEventListener("change", (e) => {
  for (const a of visibleCredentials("")) {
    if (!e.target.checked) pelicanSelected.delete(a.id);
    else if (availableCredential(a)) pelicanSelected.add(a.id);
  }
  render();
});
$("rows").addEventListener("change", (e) => {
  const id = e.target.getAttribute("data-pelican-select");
  if (!id) return;
  e.target.checked ? pelicanSelected.add(id) : pelicanSelected.delete(id);
  render();
});

key = panelKey();
if (!key) { try { key = sessionStorage.getItem(KEY_STORE) || ""; } catch (_) {} }
key ? start() : showLogin("");
