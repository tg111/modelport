const crypto = require("crypto");
const { state } = require("./state");
const { normalizeBase, preview, upstreamError } = require("./utils");

function openaiUrl(base, suffix) {
  const clean = normalizeBase(base);
  if (clean.endsWith("/v1")) return `${clean}${suffix}`;
  return `${clean}/v1${suffix}`;
}

function publicChannel(channel, options = {}) {
  const { apiKey, ...safe } = channel;
  const now = Date.now();
  const bucketMs = 60 * 60 * 1000;
  const currentBucketStart = Math.floor(now / bucketMs) * bucketMs;
  const cutoff = currentBucketStart - 23 * bucketMs;
  const usageRows = state.db.usage.filter(record => {
    if (record.channelId !== channel.id) return false;
    const time = Date.parse(record.time || "");
    return Number.isFinite(time) && time >= cutoff;
  });
  const successCount = usageRows.filter(record => record.success).length;
  const failedCount = usageRows.filter(record => record.success === false).length;
  const totalCount = successCount + failedCount;
  const successRate = totalCount ? successCount / totalCount : null;
  const buckets = Array.from({ length: 24 }, (_, index) => {
    const start = cutoff + index * bucketMs;
    return { start, end: start + bucketMs, successCount: 0, failedCount: 0 };
  });
  for (const record of usageRows) {
    const time = Date.parse(record.time || "");
    const index = Math.floor((time - cutoff) / bucketMs);
    if (index < 0 || index >= buckets.length) continue;
    if (record.success === true) buckets[index].successCount += 1;
    else if (record.success === false) buckets[index].failedCount += 1;
  }
  return {
    ...safe,
    stream: channel.stream !== false,
    ...(options.includeKey ? { apiKey } : {}),
    hasKey: Boolean(apiKey),
    usageCount: successCount,
    usageStats: {
      successCount,
      failedCount,
      totalCount,
      successRate,
      buckets: buckets.map(bucket => ({
        start: new Date(bucket.start).toISOString(),
        end: new Date(bucket.end).toISOString(),
        successCount: bucket.successCount,
        failedCount: bucket.failedCount
      }))
    }
  };
}

function sanitizeChannel(input, previous = {}) {
  const apiBase = normalizeBase(input.apiBase);
  const apiKey = typeof input.apiKey === "string" && input.apiKey ? input.apiKey : previous.apiKey;
  const protocol = ["responses", "chat"].includes(input.protocol)
    ? input.protocol
    : previous.protocol || "responses";
  return {
    id: previous.id || crypto.randomUUID(),
    apiBase,
    apiKey,
    protocol,
    note: String(input.note || ""),
    providerLink: String(input.providerLink || ""),
    enabled: input.enabled === undefined ? previous.enabled !== false : Boolean(input.enabled),
    models: Array.isArray(previous.models) ? previous.models : [],
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function fetchModels(channel) {
  const url = openaiUrl(channel.apiBase, "/models");
  const headers = { authorization: `Bearer ${channel.apiKey}` };
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw upstreamError(body.error?.message || `Model fetch failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl: url,
    upstreamBody: preview(body)
  });
  return (body.data || []).map(model => model.id).filter(Boolean);
}

function sanitizeModels(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const models = [];
  for (const item of input) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const alias = String(item?.alias || "").trim() || id;
    models.push({
      id,
      alias,
      enabled: item?.enabled === true || item?.enabled === "true"
    });
  }
  return models;
}

function mergeModels(channel, fetched) {
  const oldById = new Map((channel.models || []).map(model => [model.id, model]));
  const nextModels = [];
  const seen = new Set();

  for (const id of fetched) {
    const modelId = String(id || "").trim();
    if (!modelId || seen.has(modelId)) continue;
    const old = oldById.get(modelId);
    nextModels.push({
      id: modelId,
      alias: old?.alias || modelId,
      enabled: old ? Boolean(old.enabled) : true
    });
    seen.add(modelId);
  }

  for (const old of channel.models || []) {
    if (!old?.id || seen.has(old.id)) continue;
    nextModels.push({
      id: old.id,
      alias: old.alias || old.id,
      enabled: Boolean(old.enabled)
    });
    seen.add(old.id);
  }

  channel.models = nextModels;
  channel.updatedAt = new Date().toISOString();
}

function aliases() {
  const byAlias = new Map();
  for (const channel of state.db.channels) {
    if (channel.enabled === false) continue;
    for (const model of channel.models || []) {
      if (!model.enabled || !model.alias) continue;
      if (!byAlias.has(model.alias)) byAlias.set(model.alias, []);
      byAlias.get(model.alias).push({ channel, model });
    }
  }
  return byAlias;
}

function sortedCandidates(alias) {
  const items = aliases().get(alias) || [];
  if (items.length <= 1) return items;
  const next = state.rr.get(alias) || 0;
  const rotated = [...items.slice(next), ...items.slice(0, next)];
  state.rr.set(alias, (next + 1) % items.length);
  return rotated;
}

module.exports = {
  openaiUrl,
  publicChannel,
  sanitizeChannel,
  fetchModels,
  sanitizeModels,
  mergeModels,
  aliases,
  sortedCandidates
};
