const tokenKey = "modelport-api-key";
const loginScreen = document.querySelector("#loginScreen");
const appLayout = document.querySelector("#appLayout");
const logoutBtn = document.querySelector("#logoutBtn");
const toast = document.querySelector("#toast");
const channelsEl = document.querySelector("#channels");
const usageRows = document.querySelector("#usageRows");
const usageStatusFilter = document.querySelector("#usageStatusFilter");
const usageModelFilter = document.querySelector("#usageModelFilter");
const usageChannelFilter = document.querySelector("#usageChannelFilter");
const usagePageSummary = document.querySelector("#usagePageSummary");
const usagePageSizeEl = document.querySelector("#usagePageSize");
const usagePrevPageBtn = document.querySelector("#usagePrevPage");
const usageNextPageBtn = document.querySelector("#usageNextPage");
const channelSearchEl = document.querySelector("#channelSearch");
const channelSortEl = document.querySelector("#channelSort");
const proxyModelDropdown = document.querySelector("#proxyModelDropdown");
const proxyModelFilterBtn = document.querySelector("#proxyModelFilterBtn");
const proxyModelFilterText = document.querySelector("#proxyModelFilterText");
const proxyModelFilterPanel = document.querySelector("#proxyModelFilterPanel");
const proxyModelFilterList = document.querySelector("#proxyModelFilterList");
const selectAllProxyModelsBtn = document.querySelector("#selectAllProxyModels");
const clearChannelFiltersBtn = document.querySelector("#clearChannelFilters");
const addModal = document.querySelector("#addModal");
const editModal = document.querySelector("#editModal");
const editForm = document.querySelector("#editForm");
const errorModal = document.querySelector("#errorModal");
const errorDetailText = document.querySelector("#errorDetailText");
const errorTooltip = document.querySelector("#errorTooltip");

let apiKey = localStorage.getItem(tokenKey) || "";
let channels = [];
let channelSearch = "";
let channelSort = "created_desc";
let selectedProxyModels = new Set();
let usagePage = 1;
let usagePageSize = Number(usagePageSizeEl?.value || 20);
let usageTotalPages = 1;
let errorModalTrigger = null;

function bindProtocolAutoHint(formEl) {
  const select = formEl.querySelector("select[name='protocol']");
  const hint = formEl.querySelector("[data-protocol-auto-hint]");
  if (!select || !hint) return;
  if (select.dataset.autoHintBound === "true") {
    const auto = select.value === "auto";
    hint.classList.toggle("hidden", !auto);
    hint.classList.toggle("warning", auto);
    return;
  }
  const sync = () => {
    const auto = select.value === "auto";
    hint.classList.toggle("hidden", !auto);
    hint.classList.toggle("warning", auto);
  };
  select.addEventListener("change", sync);
  select.dataset.autoHintBound = "true";
  sync();
}

function refreshChannelsSoon(times = 3) {
  if (times <= 0) return;
  setTimeout(async () => {
    await loadChannels();
    refreshChannelsSoon(times - 1);
  }, 1600);
}

function setSecretVisible(input, button, visible) {
  input.type = visible ? "text" : "password";
  button.dataset.secretVisible = visible ? "true" : "false";
  button.setAttribute("aria-label", visible ? "隐藏密钥" : "显示密钥");
  button.setAttribute("title", visible ? "隐藏密钥" : "显示密钥");
  const icon = button.querySelector("img");
  if (icon) icon.src = visible ? "/assets/icons/eye-off.svg" : "/assets/icons/eye.svg";
}

async function copyText(value) {
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  return ok;
}

// ─── Toast ─────────────────────────────────────────────

function showToast(message, type = "info") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 4600);
}

// ─── API Request ───────────────────────────────────────

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Request failed: ${res.status}`);
  return body;
}

// ─── Auth ──────────────────────────────────────────────

function setLoggedIn(loggedIn) {
  loginScreen.classList.toggle("hidden", loggedIn);
  appLayout.classList.toggle("hidden", !loggedIn);
}

document.querySelector("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const nextKey = document.querySelector("#loginKey").value.trim();
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: nextKey })
    });
    if (!res.ok) throw new Error("API Key 不正确");
    apiKey = nextKey;
    localStorage.setItem(tokenKey, apiKey);
    setLoggedIn(true);
    await loadAll();
  } catch (error) {
    showToast(error.message, "error");
  }
});

logoutBtn.addEventListener("click", () => {
  apiKey = "";
  localStorage.removeItem(tokenKey);
  setLoggedIn(false);
});

// ─── Add Channel Modal ─────────────────────────────────

document.querySelector("#addChannelBtn").addEventListener("click", () => {
  const form = document.querySelector("#channelForm");
  addModal.classList.remove("hidden");
  addModal.querySelector("input[name='apiBase']").focus();
});

function closeAddModal() {
  addModal.classList.add("hidden");
  document.querySelector("#channelForm").reset();
}

document.querySelector("#addCloseBtn").addEventListener("click", closeAddModal);
document.querySelector("#addCancelBtn").addEventListener("click", closeAddModal);
addModal.addEventListener("click", event => {
  if (event.target === addModal) closeAddModal();
});

document.querySelector("#channelForm").addEventListener("submit", async event => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const submitBtn = formEl.querySelector("button[type='submit']");
  const payload = formPayload(formEl);
  submitBtn.disabled = true;
  try {
    const channel = await request("/api/channels", { method: "POST", body: JSON.stringify(payload) });
    closeAddModal();
    await loadChannels();
    const detecting = channel.protocolDetection?.status === "detecting";
    if (detecting) refreshChannelsSoon();
    showToast(detecting ? "渠道已保存，协议正在后台识别，正在自动获取模型..." : "渠道已保存，正在自动获取模型...", "success");
    try {
      const result = await request(`/api/channels/${channel.id}/fetch-models`, { method: "POST" });
      if (result.ok === false) throw new Error(testFailureText(result));
      showToast("渠道已保存，模型列表已自动获取", "success");
    } catch (modelError) {
      showToast(`渠道已保存，但自动获取模型失败：${modelError.message}`, "error");
    }
    await loadChannels();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

// ─── Edit Channel Modal ────────────────────────────────

document.querySelector("#editCloseBtn").addEventListener("click", closeEditModal);
document.querySelector("#editCancelBtn").addEventListener("click", closeEditModal);
editModal.addEventListener("click", event => {
  if (event.target === editModal) closeEditModal();
});

function closeErrorModal() {
  errorModal.classList.add("hidden");
  errorDetailText.textContent = "";
  errorModalTrigger?.focus();
  errorModalTrigger = null;
}

document.querySelector("#errorCloseBtn").addEventListener("click", closeErrorModal);
errorModal.addEventListener("click", event => {
  if (event.target === errorModal) closeErrorModal();
});
document.querySelector("#errorCopyBtn").addEventListener("click", async () => {
  try {
    await copyText(errorDetailText.textContent);
    showToast("错误详情已复制", "success");
  } catch (error) {
    showToast(`复制失败：${error.message}`, "error");
  }
});

function showErrorTooltip(preview) {
  errorTooltip.textContent = preview.dataset.errorDetail || "";
  errorTooltip.classList.remove("hidden");
  const anchor = preview.getBoundingClientRect();
  const tooltip = errorTooltip.getBoundingClientRect();
  const padding = 12;
  const left = Math.min(Math.max(anchor.left, padding), window.innerWidth - tooltip.width - padding);
  const above = anchor.top - tooltip.height - 8;
  const top = above >= padding ? above : Math.min(anchor.bottom + 8, window.innerHeight - tooltip.height - padding);
  errorTooltip.style.left = `${Math.max(padding, left)}px`;
  errorTooltip.style.top = `${Math.max(padding, top)}px`;
}

function hideErrorTooltip() {
  errorTooltip.classList.add("hidden");
  errorTooltip.textContent = "";
}

usageRows.addEventListener("pointerover", event => {
  const preview = event.target.closest("[data-error-detail]");
  if (preview) showErrorTooltip(preview);
});
usageRows.addEventListener("pointerout", event => {
  const preview = event.target.closest("[data-error-detail]");
  if (preview && !preview.contains(event.relatedTarget)) hideErrorTooltip();
});
usageRows.addEventListener("focusin", event => {
  const preview = event.target.closest("[data-error-detail]");
  if (preview) showErrorTooltip(preview);
});
usageRows.addEventListener("focusout", hideErrorTooltip);
document.querySelector(".table-wrap").addEventListener("scroll", hideErrorTooltip);
window.addEventListener("resize", hideErrorTooltip);

editForm.addEventListener("submit", async event => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const submitBtn = formEl.querySelector("button[type='submit']");
  const payload = formPayload(formEl);
  const id = payload.id;
  delete payload.id;
  if (!payload.apiKey) delete payload.apiKey;
  submitBtn.disabled = true;
  try {
    const channel = await request(`/api/channels/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    closeEditModal();
    const detecting = channel.protocolDetection?.status === "detecting";
    if (detecting) refreshChannelsSoon();
    showToast(detecting ? "渠道已更新，协议正在后台识别" : "渠道已更新", "success");
    await loadChannels();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (!editModal.classList.contains("hidden")) closeEditModal();
    if (!addModal.classList.contains("hidden")) closeAddModal();
    if (!errorModal.classList.contains("hidden")) closeErrorModal();
  }
});

document.addEventListener("click", async event => {
  const errorPreview = event.target.closest("[data-error-detail]");
  if (errorPreview) {
    hideErrorTooltip();
    errorModalTrigger = errorPreview;
    errorDetailText.textContent = errorPreview.dataset.errorDetail;
    errorModal.classList.remove("hidden");
    document.querySelector("#errorCopyBtn").focus();
    return;
  }
  const toggle = event.target.closest("[data-secret-toggle]");
  if (toggle) {
    const input = toggle.closest(".secret-input-wrap")?.querySelector("input");
    if (!input) return;
    setSecretVisible(input, toggle, input.type === "password");
    return;
  }

  const copy = event.target.closest("[data-secret-copy]");
  if (copy) {
    const input = copy.closest(".secret-input-wrap")?.querySelector("input");
    if (!input) return;
    try {
      const ok = await copyText(input.value);
      showToast(ok ? "密钥已复制" : "没有可复制的密钥", ok ? "success" : "error");
    } catch (error) {
      showToast(`复制失败：${error.message}`, "error");
    }
  }
});

// ─── Buttons ───────────────────────────────────────────

document.querySelector("#refreshBtn").addEventListener("click", refreshDashboard);
document.querySelector("#usageBtn").addEventListener("click", refreshDashboard);
document.querySelector("#clearUsageBtn").addEventListener("click", clearUsage);
usageStatusFilter.addEventListener("change", () => {
  usagePage = 1;
  loadUsage();
});
[usageModelFilter, usageChannelFilter].forEach(filter => filter.addEventListener("change", () => {
  usagePage = 1;
  loadUsage();
}));
usagePageSizeEl.addEventListener("change", () => {
  usagePageSize = Number(usagePageSizeEl.value || 20);
  usagePage = 1;
  loadUsage();
});
usagePrevPageBtn.addEventListener("click", () => {
  if (usagePage <= 1) return;
  usagePage -= 1;
  loadUsage();
});
usageNextPageBtn.addEventListener("click", () => {
  if (usagePage >= usageTotalPages) return;
  usagePage += 1;
  loadUsage();
});
channelsEl.addEventListener("input", event => {
  if (!event.target.matches("[data-model-filter], [data-model-id], [data-model-alias]")) return;
  applyModelFilter(event.target.closest(".channel-card"));
});
channelSearchEl.addEventListener("input", event => {
  channelSearch = event.currentTarget.value.trim().toLowerCase();
  renderChannels();
});
channelSortEl.addEventListener("change", event => {
  channelSort = event.currentTarget.value;
  renderChannels();
});
proxyModelFilterBtn.addEventListener("click", () => {
  proxyModelFilterPanel.classList.toggle("hidden");
  proxyModelFilterBtn.classList.toggle("open", !proxyModelFilterPanel.classList.contains("hidden"));
});
proxyModelFilterList.addEventListener("change", event => {
  if (!event.target.matches("[data-proxy-model-option]")) return;
  selectedProxyModels = new Set([...proxyModelFilterList.querySelectorAll("[data-proxy-model-option]:checked")].map(input => input.value));
  updateProxyModelFilterText();
  renderChannels();
});
selectAllProxyModelsBtn.addEventListener("click", () => {
  selectedProxyModels = new Set(allProxyModels());
  renderChannelFilters();
  renderChannels();
});
clearChannelFiltersBtn.addEventListener("click", () => {
  channelSearch = "";
  selectedProxyModels = new Set();
  channelSearchEl.value = "";
  renderChannelFilters();
  renderChannels();
});
document.addEventListener("click", event => {
  if (proxyModelDropdown.contains(event.target)) return;
  proxyModelFilterPanel.classList.add("hidden");
  proxyModelFilterBtn.classList.remove("open");
});

// ─── Load Data ─────────────────────────────────────────

async function loadAll() {
  await Promise.all([loadChannels(), loadUsage()]);
}

async function refreshDashboard() {
  await loadAll();
}

async function loadChannels() {
  try {
    channels = await request("/api/channels");
    renderChannelFilters();
    renderChannels();
  } catch (error) {
    showToast(error.message, "error");
    if (error.message === "Unauthorized") setLoggedIn(false);
  }
}

async function loadUsage() {
  try {
    const status = usageStatusFilter.value;
    const params = new URLSearchParams({
      page: String(usagePage),
      pageSize: String(usagePageSize)
    });
    if (status !== "all") params.set("status", status);
    if (usageModelFilter.value) params.set("model", usageModelFilter.value);
    if (usageChannelFilter.value) params.set("channelId", usageChannelFilter.value);
    const result = await request(`/api/usage?${params}`);
    const rows = Array.isArray(result) ? result : result.items || [];
    const total = Array.isArray(result) ? rows.length : Number(result.total || 0);
    usagePage = Array.isArray(result) ? 1 : Number(result.page || 1);
    usagePageSize = Array.isArray(result) ? usagePageSize : Number(result.pageSize || usagePageSize);
    usageTotalPages = Math.max(1, Math.ceil(total / usagePageSize));
    renderUsageFilters(result.filters);
    usageRows.innerHTML = rows.length
      ? rows.map(row => `
          <tr>
            <td>${new Date(row.time).toLocaleString()}</td>
            <td class="${row.success ? "status-ok" : "status-fail"}">${row.success ? "成功" : "失败"}</td>
            <td>${escapeHtml(row.model || "")}</td>
            <td>${escapeHtml(row.sourceModel || "")}</td>
            <td>${escapeHtml(row.channelNote || row.channelId || "")}</td>
            <td>${escapeHtml(row.ip || "-")}</td>
            <td class="error-cell">${failureDetailHtml(row)}</td>
            <td><button type="button" class="btn danger sm" data-usage-delete="${escapeAttr(row.id)}">删除</button></td>
          </tr>
        `).join("")
      : `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px">暂无匹配的使用记录</td></tr>`;

    usageRows.querySelectorAll("[data-usage-delete]").forEach(button => {
      button.addEventListener("click", () => deleteUsage(button.dataset.usageDelete));
    });
    renderUsagePagination(total);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderUsageFilters(filters = {}) {
  replaceSelectOptions(usageModelFilter, filters.models || [], "全部模型", value => ({ value, label: value }));
  replaceSelectOptions(usageChannelFilter, filters.channels || [], "全部渠道", channel => ({ value: channel.id, label: channel.name }));
}

function replaceSelectOptions(select, items, emptyLabel, optionFor) {
  const selected = select.value;
  select.innerHTML = `<option value="">${emptyLabel}</option>` + items.map(item => {
    const option = optionFor(item);
    return `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`;
  }).join("");
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function renderUsagePagination(total) {
  usagePageSummary.textContent = `第 ${usagePage} / ${usageTotalPages} 页，共 ${total} 条`;
  usagePageSizeEl.value = String(usagePageSize);
  usagePrevPageBtn.disabled = usagePage <= 1;
  usageNextPageBtn.disabled = usagePage >= usageTotalPages;
}

async function clearUsage() {
  if (!confirm("确认清空所有使用记录？")) return;
  try {
    await request("/api/usage", { method: "DELETE" });
    showToast("使用记录已清空", "success");
    await Promise.all([loadUsage(), loadChannels()]);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function deleteUsage(id) {
  if (!confirm("确认删除这条使用记录？")) return;
  try {
    await request(`/api/usage/${encodeURIComponent(id)}`, { method: "DELETE" });
    showToast("记录已删除", "success");
    await Promise.all([loadUsage(), loadChannels()]);
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Render Channels ───────────────────────────────────

function renderChannelFilters() {
  const available = allProxyModels();
  selectedProxyModels = new Set([...selectedProxyModels].filter(model => available.includes(model)));
  proxyModelFilterList.innerHTML = available.length
    ? available.map(model => `
        <label class="model-filter-option">
          <input type="checkbox" data-proxy-model-option value="${escapeAttr(model)}" ${selectedProxyModels.has(model) ? "checked" : ""}>
          <span>${escapeHtml(model)}</span>
        </label>
      `).join("")
    : `<p class="model-filter-empty">暂无启用模型</p>`;
  updateProxyModelFilterText(available.length);
}

function updateProxyModelFilterText(total = allProxyModels().length) {
  const selected = selectedProxyModels.size;
  proxyModelFilterText.textContent = `${selected}/${total} 个模型`;
  proxyModelFilterBtn.classList.toggle("active", selected > 0);
}

function enabledProxyModelName(model) {
  if (!model || model.enabled !== true) return "";
  return String(model.alias || model.id || "").trim();
}

function enabledProxyModels(channel) {
  return (channel.models || []).map(enabledProxyModelName).filter(Boolean);
}

function channelCreatedAt(channel) {
  const time = Date.parse(channel.createdAt || "");
  return Number.isFinite(time) ? time : 0;
}

function channelSuccessCount(channel) {
  return Number(channel.usageStats?.successCount || channel.usageCount || 0);
}

function sortChannels(items) {
  return [...items].sort((a, b) => {
    if (channelSort === "created_asc") return channelCreatedAt(a) - channelCreatedAt(b);
    if (channelSort === "success_desc") return channelSuccessCount(b) - channelSuccessCount(a);
    if (channelSort === "success_asc") return channelSuccessCount(a) - channelSuccessCount(b);
    return channelCreatedAt(b) - channelCreatedAt(a);
  });
}

function allProxyModels() {
  const names = new Set();
  for (const channel of channels) {
    if (channel.enabled === false) continue;
    for (const name of enabledProxyModels(channel)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function channelMatchesFilters(channel) {
  if (channelSearch) {
    const haystack = [
      channel.note,
      channel.apiBase
    ].filter(Boolean).join(" ").toLowerCase();
    if (!haystack.includes(channelSearch)) return false;
  }

  if (selectedProxyModels.size) {
    const hasProxyModel = enabledProxyModels(channel).some(model => selectedProxyModels.has(model));
    if (!hasProxyModel) return false;
  }

  return true;
}

function renderChannels() {
  if (!channels.length) {
    channelsEl.innerHTML = `<div class="empty-hint">还没有渠道，点击右上角"添加渠道"开始使用。</div>`;
    return;
  }

  const visibleChannels = sortChannels(channels.filter(channelMatchesFilters));
  if (!visibleChannels.length) {
    channelsEl.innerHTML = `<div class="empty-hint">没有匹配的渠道。</div>`;
    return;
  }

  channelsEl.innerHTML = visibleChannels.map(channel => {
    const enabledModels = (channel.models || []).filter(m => m.enabled);
    const modelChips = enabledModels.slice(0, 6).map(m =>
      `<span class="model-chip">${escapeHtml(m.alias || m.id)}</span>`
    ).join("");
    const moreChip = enabledModels.length > 6
      ? `<span class="model-chip more">+${enabledModels.length - 6}</span>` : "";
    const noModels = !enabledModels.length
      ? `<span class="no-models-hint">未启用模型</span>` : "";
    const isEnabled = channel.enabled !== false;
    const stats = channel.usageStats || {};
    const successCount = Number(stats.successCount || 0);
    const failedCount = Number(stats.failedCount || 0);
    const totalCount = Number(stats.totalCount || 0);
    const successRate = totalCount ? Math.round((successCount / totalCount) * 1000) / 10 : null;
    const recentBar = statusBarHtml(stats.buckets || []);
    const protocolLabel = channel.protocol === "chat"
      ? "Chat Completions"
      : channel.protocol === "auto" ? "自动识别" : "Responses";
    const detection = channel.protocolDetection || {};
    const detectionBadge = detection.status === "detecting"
      ? `<span class="badge protocol-badge">识别中</span>`
      : detection.status === "failed"
        ? `<span class="badge protocol-badge">识别失败</span>`
        : "";
    const healthClass = !totalCount ? "idle" : failedCount ? (successCount ? "warn" : "bad") : "good";
    const healthText = !totalCount ? "无请求" : failedCount ? (successCount ? "部分失败" : "全部失败") : "运行正常";

    return `
      <div class="channel-card" data-id="${channel.id}">
        <div class="provider-row">
          <div class="provider-main">
            <div class="provider-title-line">
              <span class="status-led ${isEnabled ? "on" : "off"}"></span>
              <span class="card-name">${escapeHtml(channel.note || channel.apiBase)}</span>
              <span class="badge protocol-badge">${protocolLabel}</span>
              ${detectionBadge}
            </div>
            <div class="provider-meta">
              <span class="provider-url">${escapeHtml(channel.apiBase)}</span>
              ${channel.providerLink ? `<a href="${escapeAttr(channel.providerLink)}" target="_blank" rel="noreferrer">服务商</a>` : ""}
            </div>
            <div class="model-chips">${modelChips}${moreChip}${noModels}</div>
            <div class="card-actions">
              <label class="toggle-wrap compact">
                <input type="checkbox" data-action="toggle-enabled" ${isEnabled ? "checked" : ""}>
                <span class="toggle-track"></span>
                <span class="toggle-label">${isEnabled ? "启用" : "停用"}</span>
              </label>
              <button type="button" class="btn ghost sm" data-action="edit">编辑</button>
              <button type="button" class="btn ghost sm" data-action="test">测试</button>
              <button type="button" class="btn ghost sm" data-action="fetch">获取模型</button>
              <button type="button" class="btn ghost sm" data-action="toggle-models">展开模型</button>
              <button type="button" class="btn danger sm" data-action="delete">删除</button>
            </div>
          </div>
          <div class="health-panel ${healthClass}">
            <div class="health-head">
              <span>${healthText}</span>
              <strong>${successRate === null ? "--" : `${successRate}%`}</strong>
            </div>
            <div class="stat-counts" data-tooltip="最近 24 小时：成功 ${successCount}，失败 ${failedCount}${successRate === null ? "" : `，成功率 ${successRate}%`}">
              <span><b class="stat-ok">${successCount}</b> 成功</span>
              <span><b class="stat-fail">${failedCount}</b> 失败</span>
            </div>
            ${recentBar}
          </div>
        </div>
        <div class="models-section hidden">
          <div class="model-tools">
            <input type="search" class="model-filter-input" data-model-filter placeholder="筛选上游模型 ID 或代理模型名">
            <button type="button" class="btn ghost sm" data-action="add-model">添加模型</button>
            <button type="button" class="btn ghost sm" data-action="select-all">全选</button>
            <button type="button" class="btn ghost sm" data-action="select-none">全不选</button>
            <button type="button" class="btn ghost sm" data-action="invert-selection">反选</button>
            <button type="button" class="btn primary sm" data-action="save-models">保存</button>
          </div>
          <p class="model-alias-hint">上游模型 ID 是发送到该渠道的真实 model；代理模型名是客户端请求本代理时填写的 model。多个渠道使用同一个代理模型名时会自动轮询。</p>
          <div class="model-row model-row-head">
            <span></span>
            <span>上游模型 ID</span>
            <span>代理模型名</span>
            <span></span>
          </div>
          <div class="model-rows">
            ${(channel.models || []).map(model => modelRowHtml(model)).join("") || `<p class="no-models-hint">尚未获取模型，可点击"获取模型"或手动添加。</p>`}
          </div>
        </div>
      </div>
    `;
  }).join("");

  channelsEl.querySelectorAll("[data-action]").forEach(control => {
    if (control.tagName === "BUTTON") {
      control.addEventListener("click", () =>
        channelAction(control.closest(".channel-card").dataset.id, control.dataset.action, control)
      );
    }
    if (control.matches("input[type='checkbox'][data-action='toggle-enabled']")) {
      control.addEventListener("change", () =>
        channelAction(control.closest(".channel-card").dataset.id, control.dataset.action, control)
      );
    }
  });
}

function statusBarHtml(buckets) {
  const slots = 24;
  const rows = Array.isArray(buckets) ? buckets.slice(-slots) : [];
  const pad = Array.from({ length: Math.max(0, slots - rows.length) }, () => null);
  return `
    <div class="status-bar-wrap" aria-label="最近请求状态">
      ${[...pad, ...rows].map(row => {
        if (!row) return `<span class="status-dot empty"></span>`;
        const success = Number(row.successCount || 0);
        const failed = Number(row.failedCount || 0);
        const cls = success && failed ? "mixed" : success ? "ok" : failed ? "fail" : "empty";
        const tip = success || failed
          ? `${formatHour(row.start)}时-${formatHour(row.end)}时\n成功${success} 失败${failed}`
          : `${formatHour(row.start)}时-${formatHour(row.end)}时\n无请求`;
        return `<span class="status-dot ${cls}" data-tooltip="${escapeAttr(tip)}"></span>`;
      }).join("")}
    </div>
  `;
}

function formatHour(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return String(date.getHours()).padStart(2, "0");
}

function modelRowHtml(model = {}) {
  const id = model.id || "";
  const alias = model.alias || id;
  return `
    <div class="model-row" data-model-row>
      <input type="checkbox" data-model-enabled ${model.enabled !== false ? "checked" : ""} title="启用模型">
      <input type="text" data-model-id value="${escapeAttr(id)}" placeholder="上游模型 ID">
      <input type="text" data-model-alias value="${escapeAttr(alias)}" placeholder="代理模型名">
      <button type="button" class="btn danger sm" data-action="remove-model">删除</button>
    </div>
  `;
}

function applyModelFilter(cardEl) {
  const input = cardEl.querySelector("[data-model-filter]");
  const query = (input?.value || "").trim().toLowerCase();
  const rows = [...cardEl.querySelectorAll("[data-model-row]")];
  for (const row of rows) {
    const modelId = row.querySelector("[data-model-id]")?.value || "";
    const alias = row.querySelector("[data-model-alias]")?.value || "";
    const haystack = `${modelId} ${alias}`.toLowerCase();
    row.classList.toggle("hidden-by-filter", Boolean(query) && !haystack.includes(query));
  }

  const rowsEl = cardEl.querySelector(".model-rows");
  const visibleCount = rows.filter(row => !row.classList.contains("hidden-by-filter")).length;
  let emptyEl = rowsEl.querySelector("[data-model-filter-empty]");
  if (query && rows.length && !visibleCount) {
    if (!emptyEl) {
      rowsEl.insertAdjacentHTML("beforeend", `<p class="no-models-hint" data-model-filter-empty>没有匹配的模型。</p>`);
    }
  } else {
    emptyEl?.remove();
  }
}

// ─── Channel Actions ───────────────────────────────────

async function channelAction(id, action, control) {
  const cardEl = channelsEl.querySelector(`[data-id="${id}"]`);
  try {
    if (action === "toggle-enabled") {
      await request(`/api/channels/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: control.checked }) });
      showToast(control.checked ? "渠道已启用" : "渠道已停用", "success");
      await loadChannels();
      return;
    }
    if (action === "edit") {
      openEditModal(id);
      return;
    }
    if (action === "test") {
      showToast("正在发送 Responses 测试：你好", "info");
      try {
        const result = await request(`/api/channels/${id}/test`, { method: "POST", body: JSON.stringify({ message: "你好" }) });
        if (result.ok) {
          showToast(`渠道可用：${result.response || result.alias || result.model}`, "success");
        } else {
          showToast(`渠道不可用：${testFailureText(result)}`, "error");
        }
        await loadUsage();
      } catch (error) {
        if (error.message === "Not found") {
          showToast("测试接口不存在：请重建并重启容器", "error");
        } else {
          showToast(error.message, "error");
        }
      }
      return;
    }
    if (action === "toggle-models") {
      const modelsEl = cardEl.querySelector(".models-section");
      const btn = cardEl.querySelector('[data-action="toggle-models"]');
      const willOpen = modelsEl.classList.contains("hidden");
      modelsEl.classList.toggle("hidden", !willOpen);
      btn.textContent = willOpen ? "折叠模型" : "展开模型";
      return;
    }
    if (action === "select-all" || action === "select-none" || action === "invert-selection") {
      const checks = [...cardEl.querySelectorAll("[data-model-row]:not(.hidden-by-filter) [data-model-enabled]")];
      for (const cb of checks) {
        if (action === "select-all") cb.checked = true;
        if (action === "select-none") cb.checked = false;
        if (action === "invert-selection") cb.checked = !cb.checked;
      }
      return;
    }
    if (action === "add-model") {
      const rowsEl = cardEl.querySelector(".model-rows");
      rowsEl.querySelector(".no-models-hint")?.remove();
      rowsEl.insertAdjacentHTML("beforeend", modelRowHtml({ enabled: true }));
      applyModelFilter(cardEl);
      rowsEl.querySelector("[data-model-row]:last-child [data-model-id]").focus();
      return;
    }
    if (action === "remove-model") {
      control.closest("[data-model-row]")?.remove();
      applyModelFilter(cardEl);
      const rowsEl = cardEl.querySelector(".model-rows");
      if (!rowsEl.querySelector("[data-model-row]")) {
        rowsEl.innerHTML = `<p class="no-models-hint">尚未获取模型，可点击"获取模型"或手动添加。</p>`;
      }
      return;
    }
    if (action === "fetch") {
      const result = await request(`/api/channels/${id}/fetch-models`, { method: "POST" });
      if (result.ok === false) {
        showToast(`获取模型失败：${testFailureText(result)}`, "error");
        return;
      }
      showToast("模型列表已更新", "success");
      await loadChannels();
      return;
    }
    if (action === "delete") {
      if (!confirm("确认删除这个渠道？")) return;
      await request(`/api/channels/${id}`, { method: "DELETE" });
      await loadChannels();
      return;
    }
    if (action === "save-models") {
      const rows = [...cardEl.querySelectorAll("[data-model-row]")];
      const models = rows.map(row => {
        const modelId = row.querySelector("[data-model-id]").value.trim();
        return {
          id: modelId,
          alias: row.querySelector("[data-model-alias]").value.trim() || modelId,
          enabled: row.querySelector("[data-model-enabled]").checked
        };
      });
      if (models.some(model => !model.id)) {
        showToast("上游模型 ID 不能为空", "error");
        return;
      }
      if (new Set(models.map(model => model.id)).size !== models.length) {
        showToast("上游模型 ID 不能重复", "error");
        return;
      }
      await request(`/api/channels/${id}/models`, { method: "PUT", body: JSON.stringify({ models }) });
      showToast("模型设置已保存", "success");
      await loadChannels();
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ─── Edit Modal ────────────────────────────────────────

async function openEditModal(id) {
  let channel = channels.find(c => c.id === id);
  if (!channel) return showToast("渠道不存在", "error");
  try {
    channel = await request(`/api/channels/${id}`);
  } catch (error) {
    showToast(error.message, "error");
    return;
  }
  editForm.elements.id.value = channel.id;
  editForm.elements.apiBase.value = channel.apiBase || "";
  editForm.elements.apiKey.value = channel.apiKey || "";
  editForm.elements.note.value = channel.note || "";
  editForm.elements.providerLink.value = channel.providerLink || "";
  editForm.elements.protocol.value = channel.protocol || "auto";
  bindProtocolAutoHint(editForm);
  editModal.classList.remove("hidden");
  editForm.elements.apiBase.focus();
}

function closeEditModal() {
  editModal.classList.add("hidden");
  editForm.reset();
}

// ─── Utilities ─────────────────────────────────────────

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function formPayload(formEl) {
  return Object.fromEntries(new FormData(formEl).entries());
}

function failureDetail(row) {
  if (row.success) return "";
  const parts = [];
  if (row.error || row.message) parts.push(row.error || row.message);
  if (row.upstreamStatus) parts.push(`HTTP ${row.upstreamStatus}`);
  if (row.upstreamUrl) parts.push(`请求地址：${row.upstreamUrl}`);
  if (row.upstreamBody) parts.push(typeof row.upstreamBody === "string" ? row.upstreamBody : JSON.stringify(row.upstreamBody, null, 2));
  return parts.join("\n");
}

function failureDetailHtml(row) {
  const detail = failureDetail(row);
  if (!detail) return "";
  return `<button type="button" class="error-preview" data-error-detail="${escapeAttr(detail)}">${escapeHtml(detail)}</button>`;
}

function testFailureText(result) {
  const parts = [result.message];
  if (result.upstreamStatus) parts.push(`HTTP ${result.upstreamStatus}`);
  if (result.upstreamBody) parts.push(result.upstreamBody);
  return parts.filter(Boolean).join(" / ");
}

// ─── Init ──────────────────────────────────────────────

if (apiKey) {
  setLoggedIn(true);
  loadAll();
} else {
  setLoggedIn(false);
}

bindProtocolAutoHint(document.querySelector("#channelForm"));
bindProtocolAutoHint(editForm);
