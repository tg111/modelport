const channelsEl = document.querySelector("#channels");
const usageRows = document.querySelector("#usageRows");
const usageStatusFilter = document.querySelector("#usageStatusFilter");
const usagePageSummary = document.querySelector("#usagePageSummary");
const usagePageSizeEl = document.querySelector("#usagePageSize");
const usagePrevPageBtn = document.querySelector("#usagePrevPage");
const usageNextPageBtn = document.querySelector("#usageNextPage");
const channelSearchEl = document.querySelector("#channelSearch");
const channelSortEl = document.querySelector("#channelSort");
const channelVisibilityControl = document.querySelector(".channel-visibility-control");
const proxyModelDropdown = document.querySelector("#proxyModelDropdown");
const proxyModelFilterBtn = document.querySelector("#proxyModelFilterBtn");
const proxyModelFilterText = document.querySelector("#proxyModelFilterText");
const proxyModelFilterPanel = document.querySelector("#proxyModelFilterPanel");
const proxyModelFilterList = document.querySelector("#proxyModelFilterList");
const selectAllProxyModelsBtn = document.querySelector("#selectAllProxyModels");
const clearChannelFiltersBtn = document.querySelector("#clearChannelFilters");
const toast = document.querySelector("#toast");

let channelSearch = "";
let channelSort = "created_desc";
let channelVisibility = "all";
let selectedProxyModels = new Set();
let usagePage = 1;
let usagePageSize = Number(usagePageSizeEl.value || 20);
let usageTotalPages = 1;

const channels = [
  {
    id: "openai",
    apiBase: "https://api.openai.com/v1",
    note: "OpenAI 主渠道",
    providerLink: "https://platform.openai.com",
    protocol: "responses",
    enabled: true,
    createdAt: "2026-07-09T08:10:00Z",
    usageStats: {
      successCount: 92,
      failedCount: 1,
      totalCount: 93,
      buckets: bucketSeries([1, 2, 0, 4, 6, 7, 5, 8, 6, 3, 9, 11], [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
    },
    models: [
      { id: "gpt-5", alias: "codex-main", enabled: true },
      { id: "gpt-5-mini", alias: "fast-chat", enabled: true },
      { id: "gpt-image-1", alias: "image-pro", enabled: true }
    ]
  },
  {
    id: "anyrouter",
    apiBase: "https://anyrouter.top/v1",
    note: "AnyRouter 备用",
    providerLink: "https://anyrouter.top",
    protocol: "responses",
    enabled: true,
    createdAt: "2026-07-09T07:42:00Z",
    usageStats: {
      successCount: 41,
      failedCount: 3,
      totalCount: 44,
      buckets: bucketSeries([0, 1, 3, 0, 2, 5, 4, 4, 3, 6, 7, 6], [0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0])
    },
    models: [
      { id: "gpt-5", alias: "codex-main", enabled: true },
      { id: "gpt-4.1-mini", alias: "fast-chat", enabled: true }
    ]
  },
  {
    id: "chat",
    apiBase: "https://gateway.example.com/v1",
    note: "Chat Completions 兼容渠道",
    providerLink: "",
    protocol: "chat",
    enabled: false,
    createdAt: "2026-07-08T12:05:00Z",
    usageStats: {
      successCount: 12,
      failedCount: 4,
      totalCount: 16,
      buckets: bucketSeries([0, 0, 1, 0, 2, 2, 1, 3, 0, 1, 1, 1], [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0])
    },
    models: [
      { id: "claude-compatible-chat", alias: "tools-lite", enabled: true },
      { id: "deepseek-chat", alias: "fast-chat", enabled: false }
    ]
  }
];

const usageItems = [
  ["codex-main", "gpt-5", "OpenAI 主渠道", true, ""],
  ["fast-chat", "gpt-4.1-mini", "AnyRouter 备用", true, ""],
  ["tools-lite", "claude-compatible-chat", "Chat Completions 兼容渠道", false, "HTTP 429 / rate_limit_exceeded"],
  ["image-pro", "gpt-image-1", "OpenAI 主渠道", true, ""],
  ["codex-main", "gpt-5", "AnyRouter 备用", true, ""],
  ["fast-chat", "gpt-5-mini", "OpenAI 主渠道", true, ""]
].map(([model, sourceModel, channelNote, success, error], index) =>
  usage(model, sourceModel, channelNote, success, error, index)
);

function bucketSeries(successes, failures) {
  const now = Date.now();
  return successes.map((successCount, index) => {
    const start = now - (successes.length - index) * 60 * 60 * 1000;
    return {
      start,
      end: start + 60 * 60 * 1000,
      successCount,
      failedCount: failures[index] || 0
    };
  });
}

function usage(model, sourceModel, channelNote, success, error, index) {
  return {
    id: `${model}-${sourceModel}-${Math.random().toString(16).slice(2)}`,
    time: new Date(Date.now() - index * 9 * 60 * 1000).toISOString(),
    model,
    sourceModel,
    channelNote,
    success,
    error
  };
}

function showToast(message, type = "info") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3000);
}

function renderUsage() {
  const status = usageStatusFilter.value;
  const rows = usageItems.filter(row => {
    if (status === "success") return row.success;
    if (status === "failed") return !row.success;
    return true;
  });
  usageTotalPages = Math.max(1, Math.ceil(rows.length / usagePageSize));
  usagePage = Math.min(usagePage, usageTotalPages);
  const pageRows = rows.slice((usagePage - 1) * usagePageSize, usagePage * usagePageSize);
  usageRows.innerHTML = pageRows.map(row => `
    <tr>
      <td>${new Date(row.time).toLocaleString()}</td>
      <td class="${row.success ? "status-ok" : "status-fail"}">${row.success ? "成功" : "失败"}</td>
      <td>${escapeHtml(row.model)}</td>
      <td>${escapeHtml(row.sourceModel)}</td>
      <td>${escapeHtml(row.channelNote)}</td>
      <td class="error-cell">${escapeHtml(row.error || "")}</td>
      <td><button type="button" class="btn danger sm" data-demo-disabled>删除</button></td>
    </tr>
  `).join("") || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">暂无匹配的使用记录</td></tr>`;
  usagePageSummary.textContent = `第 ${usagePage} / ${usageTotalPages} 页，共 ${rows.length} 条`;
  usagePrevPageBtn.disabled = usagePage <= 1;
  usageNextPageBtn.disabled = usagePage >= usageTotalPages;
}

function renderChannelFilters() {
  const available = allProxyModels();
  selectedProxyModels = new Set([...selectedProxyModels].filter(model => available.includes(model)));
  proxyModelFilterList.innerHTML = available.map(model => `
    <label class="model-filter-option">
      <input type="checkbox" data-proxy-model-option value="${escapeAttr(model)}" ${selectedProxyModels.has(model) ? "checked" : ""}>
      <span>${escapeHtml(model)}</span>
    </label>
  `).join("");
  updateProxyModelFilterText(available.length);
}

function updateProxyModelFilterText(total = allProxyModels().length) {
  proxyModelFilterText.textContent = `${selectedProxyModels.size}/${total} 个模型`;
  proxyModelFilterBtn.classList.toggle("active", selectedProxyModels.size > 0);
}

function enabledProxyModels(channel) {
  return (channel.models || [])
    .filter(model => model.enabled !== false)
    .map(model => String(model.alias || model.id || "").trim())
    .filter(Boolean);
}

function allProxyModels() {
  const names = new Set();
  for (const channel of channels) {
    if (channel.enabled === false) continue;
    for (const name of enabledProxyModels(channel)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function channelSuccessCount(channel) {
  return Number(channel.usageStats?.successCount || 0);
}

function channelName(channel) {
  return channel.note || channel.apiBase || "";
}

function sortChannels(items) {
  return [...items].sort((a, b) => {
    if (channelSort === "created_asc") return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (channelSort === "name_asc") return channelName(a).localeCompare(channelName(b), "zh-CN");
    if (channelSort === "success_desc") return channelSuccessCount(b) - channelSuccessCount(a);
    if (channelSort === "success_asc") return channelSuccessCount(a) - channelSuccessCount(b);
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

function channelMatchesFilters(channel) {
  if (channelVisibility === "enabled" && channel.enabled === false) return false;

  if (channelSearch) {
    const haystack = [channel.note, channel.apiBase, ...enabledProxyModels(channel)].join(" ").toLowerCase();
    if (!haystack.includes(channelSearch)) return false;
  }
  if (selectedProxyModels.size) {
    return enabledProxyModels(channel).some(model => selectedProxyModels.has(model));
  }
  return true;
}

function renderChannels() {
  const visibleChannels = sortChannels(channels.filter(channelMatchesFilters));
  channelsEl.innerHTML = visibleChannels.map(channelHtml).join("") || `<div class="empty-hint">没有匹配的渠道。</div>`;
}

function channelHtml(channel) {
  const enabledModels = (channel.models || []).filter(model => model.enabled);
  const stats = channel.usageStats || {};
  const successCount = Number(stats.successCount || 0);
  const failedCount = Number(stats.failedCount || 0);
  const totalCount = Number(stats.totalCount || 0);
  const successRate = totalCount ? Math.round((successCount / totalCount) * 1000) / 10 : null;
  const protocolLabel = channel.protocol === "chat" ? "Chat Completions" : "Responses";
  const healthClass = !totalCount ? "idle" : failedCount ? (successCount ? "warn" : "bad") : "good";
  const healthText = !totalCount ? "无请求" : failedCount ? (successCount ? "部分失败" : "全部失败") : "运行正常";
  return `
    <div class="channel-card" data-id="${escapeAttr(channel.id)}">
      <div class="provider-row">
        <div class="provider-main">
          <div class="provider-title-line">
            <span class="status-led ${channel.enabled !== false ? "on" : "off"}"></span>
            <span class="card-name">${escapeHtml(channel.note || channel.apiBase)}</span>
            <span class="badge protocol-badge">${protocolLabel}</span>
          </div>
          <div class="provider-meta">
            <span class="provider-url">${escapeHtml(channel.apiBase)}</span>
            ${channel.providerLink ? `<a href="${escapeAttr(channel.providerLink)}" target="_blank" rel="noreferrer">渠道官网</a>` : ""}
          </div>
          <div class="model-chips">
            ${enabledModels.map(model => `<span class="model-chip">${escapeHtml(model.alias || model.id)}</span>`).join("")}
          </div>
          <div class="card-actions">
            <label class="toggle-wrap compact">
              <input type="checkbox" data-demo-disabled ${channel.enabled !== false ? "checked" : ""}>
              <span class="toggle-track"></span>
              <span class="toggle-label">${channel.enabled !== false ? "启用" : "停用"}</span>
            </label>
            <button type="button" class="btn ghost sm" data-demo-disabled>编辑</button>
            <button type="button" class="btn ghost sm" data-demo-test>测试</button>
            <button type="button" class="btn ghost sm" data-demo-disabled>获取模型</button>
            <button type="button" class="btn ghost sm" data-toggle-models>展开模型</button>
            <button type="button" class="btn danger sm" data-demo-disabled>删除</button>
          </div>
        </div>
        <div class="health-panel ${healthClass}">
          <div class="health-head">
            <span>${healthText}</span>
            <strong>${successRate === null ? "--" : `${successRate}%`}</strong>
          </div>
          <div class="stat-counts" data-tooltip="最近 24 小时：成功 ${successCount}，失败 ${failedCount}">
            <span><b class="stat-ok">${successCount}</b> 成功</span>
            <span><b class="stat-fail">${failedCount}</b> 失败</span>
          </div>
          ${statusBarHtml(stats.buckets || [])}
        </div>
      </div>
      <div class="models-section hidden">
        <div class="model-tools">
          <input type="search" class="model-filter-input" data-model-filter placeholder="筛选上游模型 ID 或代理模型名">
          <button type="button" class="btn ghost sm" data-demo-disabled>添加模型</button>
          <button type="button" class="btn ghost sm" data-demo-disabled>全选</button>
          <button type="button" class="btn ghost sm" data-demo-disabled>全不选</button>
          <button type="button" class="btn ghost sm" data-demo-disabled>反选</button>
          <button type="button" class="btn primary sm" data-demo-disabled>保存</button>
        </div>
        <p class="model-alias-hint">上游模型 ID 是发送到该渠道的真实 model；代理模型名是客户端请求本代理时填写的 model。多个渠道使用同一个代理模型名时会自动轮询。</p>
        <div class="model-row model-row-head">
          <span></span>
          <span>上游模型 ID</span>
          <span>代理模型名</span>
          <span></span>
        </div>
        <div class="model-rows">
          ${(channel.models || []).map(modelRowHtml).join("")}
        </div>
      </div>
    </div>
  `;
}

function modelRowHtml(model) {
  return `
    <div class="model-row" data-model-row>
      <input type="checkbox" data-model-enabled ${model.enabled !== false ? "checked" : ""} title="启用模型">
      <input type="text" data-model-id value="${escapeAttr(model.id)}" placeholder="上游模型 ID">
      <input type="text" data-model-alias value="${escapeAttr(model.alias || model.id)}" placeholder="代理模型名">
      <button type="button" class="btn danger sm" data-demo-disabled>删除</button>
    </div>
  `;
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
        return `<span class="status-dot ${cls}" data-tooltip="${formatHour(row.start)}时-${formatHour(row.end)}时\n成功${success} 失败${failed}"></span>`;
      }).join("")}
    </div>
  `;
}

function formatHour(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return String(date.getHours()).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function bindEvents() {
  channelSearchEl.addEventListener("input", event => {
    channelSearch = event.currentTarget.value.trim().toLowerCase();
    renderChannels();
  });
  channelSortEl.addEventListener("change", event => {
    channelSort = event.currentTarget.value;
    renderChannels();
  });
  channelVisibilityControl.addEventListener("click", event => {
    const button = event.target.closest("[data-channel-visibility]");
    if (!button) return;
    channelVisibility = button.dataset.channelVisibility;
    renderChannelVisibilityControl();
    renderChannels();
    showToast("本地部署后，此展示偏好会保存到后端", "info");
  });
  proxyModelFilterBtn.addEventListener("click", () => {
    proxyModelFilterPanel.classList.toggle("hidden");
    proxyModelFilterBtn.classList.toggle("open", !proxyModelFilterPanel.classList.contains("hidden"));
  });
  proxyModelFilterList.addEventListener("change", () => {
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
  usageStatusFilter.addEventListener("change", () => {
    usagePage = 1;
    renderUsage();
  });
  usagePageSizeEl.addEventListener("change", () => {
    usagePageSize = Number(usagePageSizeEl.value || 20);
    usagePage = 1;
    renderUsage();
  });
  usagePrevPageBtn.addEventListener("click", () => {
    if (usagePage > 1) usagePage -= 1;
    renderUsage();
  });
  usageNextPageBtn.addEventListener("click", () => {
    if (usagePage < usageTotalPages) usagePage += 1;
    renderUsage();
  });
  document.querySelector("#refreshBtn").addEventListener("click", () => showToast("这是静态演示页，数据已刷新", "success"));
  document.querySelector("#usageBtn").addEventListener("click", () => showToast("这是静态演示页，数据已刷新", "success"));
  document.querySelector("#addChannelBtn").addEventListener("click", () => showToast("GitHub Pages demo 不连接后端，请本地部署后添加渠道", "info"));
  document.querySelector("#clearUsageBtn").addEventListener("click", () => showToast("静态演示页不会删除记录", "info"));
  channelsEl.addEventListener("click", event => {
    if (event.target.matches("[data-toggle-models]")) {
      const card = event.target.closest(".channel-card");
      const models = card.querySelector(".models-section");
      const open = models.classList.contains("hidden");
      models.classList.toggle("hidden", !open);
      event.target.textContent = open ? "折叠模型" : "展开模型";
      return;
    }
    if (event.target.matches("[data-demo-test]")) {
      showToast("模拟测试成功：hello from ModelPort", "success");
      return;
    }
    if (event.target.closest("[data-demo-disabled]")) {
      showToast("这是静态演示页，请本地部署后操作", "info");
    }
  });
  channelsEl.addEventListener("input", event => {
    if (!event.target.matches("[data-model-filter]")) return;
    const query = event.target.value.trim().toLowerCase();
    const card = event.target.closest(".channel-card");
    for (const row of card.querySelectorAll("[data-model-row]")) {
      const modelId = row.querySelector("[data-model-id]").value;
      const alias = row.querySelector("[data-model-alias]").value;
      row.classList.toggle("hidden-by-filter", query && !`${modelId} ${alias}`.toLowerCase().includes(query));
    }
  });
  document.addEventListener("click", event => {
    if (proxyModelDropdown.contains(event.target)) return;
    proxyModelFilterPanel.classList.add("hidden");
    proxyModelFilterBtn.classList.remove("open");
  });
}

function renderChannelVisibilityControl() {
  channelVisibilityControl.querySelectorAll("[data-channel-visibility]").forEach(button => {
    const active = button.dataset.channelVisibility === channelVisibility;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

bindEvents();
renderChannelVisibilityControl();
renderChannelFilters();
renderChannels();
renderUsage();
