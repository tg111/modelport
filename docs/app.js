const channels = [
  {
    name: "OpenAI Primary",
    apiBase: "https://api.openai.com/v1",
    protocol: "Responses native",
    status: "ok",
    latency: "418 ms",
    aliases: ["codex-main", "gpt-5", "image-pro"]
  },
  {
    name: "AnyRouter Backup",
    apiBase: "https://anyrouter.top/v1",
    protocol: "Responses native",
    status: "ok",
    latency: "536 ms",
    aliases: ["codex-main", "fast-chat"]
  },
  {
    name: "Chat Compatible",
    apiBase: "https://gateway.example.com/v1",
    protocol: "Chat bridge",
    status: "warn",
    latency: "812 ms",
    aliases: ["fast-chat", "tools-lite"]
  },
  {
    name: "Image Lab",
    apiBase: "https://images.example.com/v1",
    protocol: "Image APIs",
    status: "ok",
    latency: "641 ms",
    aliases: ["image-pro"]
  }
];

const models = [
  ["codex-main", "gpt-5 / gpt-5.1 fallback", "2 channels"],
  ["fast-chat", "gpt-4.1-mini compatible", "2 channels"],
  ["image-pro", "image generation + edits", "2 channels"],
  ["tools-lite", "chat tools bridge", "1 channel"]
];

const usage = [
  ["09:54", "codex-main", "OpenAI Primary", "success"],
  ["09:50", "fast-chat", "AnyRouter Backup", "success"],
  ["09:42", "tools-lite", "Chat Compatible", "success"],
  ["09:31", "image-pro", "Image Lab", "success"],
  ["09:18", "codex-main", "AnyRouter Backup", "retry"]
];

const channelList = document.querySelector("#channelList");
const modelList = document.querySelector("#modelList");
const usageRows = document.querySelector("#usageRows");
const search = document.querySelector("#channelSearch");
const rotateBtn = document.querySelector("#rotateBtn");
const failoverBtn = document.querySelector("#failoverBtn");
const healthyCount = document.querySelector("#healthyCount");
const requestCount = document.querySelector("#requestCount");
const usageBadge = document.querySelector("#usageBadge");

function badgeClass(status) {
  if (status === "ok" || status === "success") return "ok";
  if (status === "warn" || status === "retry") return "warn";
  return "fail";
}

function statusText(status) {
  return {
    ok: "healthy",
    warn: "degraded",
    fail: "offline",
    success: "success",
    retry: "retry"
  }[status] || status;
}

function renderChannels(items = channels) {
  channelList.innerHTML = items.map((channel) => `
    <article class="channel-row">
      <div class="channel-main">
        <strong>${channel.name}</strong>
        <span>${channel.apiBase}</span>
      </div>
      <span class="badge ${badgeClass(channel.status)}">${statusText(channel.status)}</span>
      <span>${channel.latency}</span>
      <div class="aliases">
        ${channel.aliases.map((alias) => `<span class="alias">${alias}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function renderModels() {
  modelList.innerHTML = models.map(([alias, source, count]) => `
    <article class="model-item">
      <div>
        <strong>${alias}</strong>
        <span>${source}</span>
      </div>
      <span class="pill">${count}</span>
    </article>
  `).join("");
}

function renderUsage(rows = usage) {
  usageRows.innerHTML = rows.map(([time, model, channel, status]) => `
    <tr>
      <td>${time}</td>
      <td>${model}</td>
      <td>${channel}</td>
      <td><span class="badge ${badgeClass(status)}">${statusText(status)}</span></td>
    </tr>
  `).join("");
}

function filterChannels() {
  const term = search.value.trim().toLowerCase();
  const filtered = channels.filter((channel) => {
    const text = `${channel.name} ${channel.apiBase} ${channel.protocol} ${channel.aliases.join(" ")}`.toLowerCase();
    return text.includes(term);
  });
  renderChannels(filtered);
}

function simulateRotation() {
  const next = usage.shift();
  usage.push(next);
  channels.push(channels.shift());
  renderChannels();
  renderUsage();
  requestCount.textContent = String(Number(requestCount.textContent) + 1);
  usageBadge.textContent = "rotated";
}

function simulateFailover() {
  const target = channels.find((channel) => channel.status === "ok");
  if (target) target.status = "warn";
  usage.unshift(["now", "codex-main", "AnyRouter Backup", "retry"]);
  usage.pop();
  healthyCount.textContent = String(channels.filter((channel) => channel.status === "ok").length);
  renderChannels();
  renderUsage();
  usageBadge.textContent = "failover";
}

search.addEventListener("input", filterChannels);
rotateBtn.addEventListener("click", simulateRotation);
failoverBtn.addEventListener("click", simulateFailover);

renderChannels();
renderModels();
renderUsage();
