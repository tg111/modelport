const { state, saveDb, usageRecord } = require("./state");
const { readBody, requireAuth, sendError, sendJson } = require("./http");
const {
  detectAndUpdateProtocol,
  fetchModels,
  markProtocolDetecting,
  mergeModels,
  publicChannel,
  sanitizeChannel,
  sanitizeModels
} = require("./channels");
const { responseOutputText, testChannel } = require("./providers");
const { clientIp, normalizeUsage } = require("./utils");

function queueProtocolDetection(channel) {
  if (channel.protocol !== "auto") return;
  markProtocolDetecting(channel);
  setImmediate(async () => {
    await detectAndUpdateProtocol(channel);
    saveDb();
  });
}

function clearProtocolDetectionWhenManual(channel) {
  if (channel.protocol === "auto") return;
  delete channel.protocolDetection;
}

function elapsedSeconds(startedAt) {
  return Number(((Date.now() - startedAt) / 1000).toFixed(1));
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    return sendJson(res, body.apiKey === state.apiKey ? 200 : 401, { ok: body.apiKey === state.apiKey });
  }
  if (!requireAuth(req, res)) return;

  if (req.method === "GET" && url.pathname === "/api/preferences") {
    return sendJson(res, 200, state.db.preferences);
  }
  if (req.method === "PUT" && url.pathname === "/api/preferences") {
    const body = await readBody(req);
    const hasVisibility = Object.hasOwn(body, "channelVisibility");
    const hasSort = Object.hasOwn(body, "channelSort");
    if (!hasVisibility && !hasSort) {
      return sendError(res, 400, "At least one preference is required");
    }
    if (hasVisibility && !["all", "enabled"].includes(body.channelVisibility)) {
      return sendError(res, 400, "channelVisibility must be all or enabled");
    }
    if (hasSort && !["created_desc", "created_asc", "name_asc", "success_desc", "success_asc"].includes(body.channelSort)) {
      return sendError(res, 400, "channelSort is invalid");
    }
    if (hasVisibility) state.db.preferences.channelVisibility = body.channelVisibility;
    if (hasSort) state.db.preferences.channelSort = body.channelSort;
    saveDb();
    return sendJson(res, 200, state.db.preferences);
  }

  if (req.method === "GET" && url.pathname === "/api/channels") {
    return sendJson(res, 200, state.db.channels.map(publicChannel));
  }
  if (req.method === "POST" && url.pathname === "/api/channels") {
    const body = await readBody(req);
    if (!body.apiBase) return sendError(res, 400, "apiBase is required");
    const channel = sanitizeChannel(body);
    queueProtocolDetection(channel);
    clearProtocolDetectionWhenManual(channel);
    state.db.channels.unshift(channel);
    saveDb();
    return sendJson(res, 201, publicChannel(channel));
  }
  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)(?:\/(models|fetch-models|test|test-model|enabled))?$/);
  if (channelMatch) {
    const channel = state.db.channels.find(item => item.id === channelMatch[1]);
    if (!channel) return sendError(res, 404, "Channel not found");
    const action = channelMatch[2];
    if (req.method === "GET" && !action) {
      return sendJson(res, 200, publicChannel(channel, { includeKey: true }));
    }
    if (req.method === "PUT" && !action) {
      const body = await readBody(req);
      const nextChannel = sanitizeChannel(body, channel);
      Object.assign(channel, nextChannel);
      queueProtocolDetection(channel);
      clearProtocolDetectionWhenManual(channel);
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
    if (req.method === "DELETE" && !action) {
      state.db.channels = state.db.channels.filter(item => item.id !== channel.id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && action === "fetch-models") {
      try {
        const models = await fetchModels(channel);
        mergeModels(channel, models);
        saveDb();
        return sendJson(res, 200, publicChannel(channel));
      } catch (error) {
        return sendJson(res, 200, {
          ok: false,
          message: error.message,
          upstreamStatus: error.upstreamStatus || null,
          upstreamBody: error.upstreamBody || null
        });
      }
    }
    if (req.method === "POST" && action === "test") {
      const body = await readBody(req);
      const testMessage = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "你好";
      const modelId = typeof body.modelId === "string" && body.modelId.trim()
        ? body.modelId.trim()
        : channel.testModelId || undefined;
      const startedAt = Date.now();
      try {
        const result = await testChannel(channel, testMessage, modelId);
        usageRecord({
          success: true,
          endpoint: "/api/channels/:id/test",
          model: result.model.alias || result.model.id,
          sourceModel: result.model.id,
          channelId: channel.id,
          channelNote: channel.note,
          ip: clientIp(req),
          request: testMessage,
          durationSeconds: elapsedSeconds(startedAt),
          ...normalizeUsage(result.upstream.body?.usage || result.upstream.body?.usageMetadata)
        });
        return sendJson(res, 200, {
          ok: true,
          message: "Channel is available",
          request: testMessage,
          model: result.model.id,
          alias: result.model.alias || result.model.id,
          response: responseOutputText(result.upstream.body)
        });
      } catch (error) {
        const model = modelId
          ? (channel.models || []).find(item => item.id === modelId) || { id: modelId }
          : (channel.models || []).find(item => item.enabled) || (channel.models || [])[0] || {};
        usageRecord({
          success: false,
          endpoint: "/api/channels/:id/test",
          model: model.alias || model.id || "",
          sourceModel: model.id || "",
          channelId: channel.id,
          channelNote: channel.note,
          ip: clientIp(req),
          request: testMessage,
          durationSeconds: elapsedSeconds(startedAt),
          error: error.message,
          upstreamStatus: error.upstreamStatus || null,
          upstreamUrl: error.upstreamUrl || null,
          upstreamBody: error.upstreamBody || null
        });
        return sendJson(res, 200, {
          ok: false,
          message: error.message,
          upstreamStatus: error.upstreamStatus || null,
          upstreamBody: error.upstreamBody || null
        });
      }
    }
    if (req.method === "PUT" && action === "enabled") {
      const body = await readBody(req);
      channel.enabled = Boolean(body.enabled);
      channel.updatedAt = new Date().toISOString();
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
    if (req.method === "PUT" && action === "models") {
      const body = await readBody(req);
      channel.models = sanitizeModels(body.models);
      if (!channel.models.some(model => model.id === channel.testModelId)) channel.testModelId = "";
      channel.updatedAt = new Date().toISOString();
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
    if (req.method === "PUT" && action === "test-model") {
      const body = await readBody(req);
      const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      if (!channel.models.some(model => model.id === modelId)) return sendError(res, 400, "Model not found for this channel");
      channel.testModelId = modelId;
      channel.updatedAt = new Date().toISOString();
      saveDb();
      return sendJson(res, 200, publicChannel(channel));
    }
  }
  if (req.method === "GET" && url.pathname === "/api/usage") {
    const rawPage = Number(url.searchParams.get("page") || 1);
    const rawPageSize = Number(url.searchParams.get("pageSize") || url.searchParams.get("limit") || 20);
    const pageSize = Math.min(Math.max(Number.isFinite(rawPageSize) ? Math.floor(rawPageSize) : 20, 1), 100);
    const status = url.searchParams.get("status") || "all";
    const model = url.searchParams.get("model") || "";
    const channelId = url.searchParams.get("channelId") || "";
    const rows = state.db.usage.filter(record => {
      if (status === "success" && record.success !== true) return false;
      if (status === "failed" && record.success !== false) return false;
      if (model && record.model !== model) return false;
      if (channelId && record.channelId !== channelId) return false;
      return true;
    });
    const models = [...new Set(state.db.usage.map(record => record.model).filter(Boolean))].sort();
    const channelOptions = new Map();
    for (const channel of state.db.channels) channelOptions.set(channel.id, channel.note || channel.apiBase || channel.id);
    for (const record of state.db.usage) {
      if (record.channelId && !channelOptions.has(record.channelId)) {
        channelOptions.set(record.channelId, record.channelNote || record.channelId);
      }
    }
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(Number.isFinite(rawPage) ? Math.floor(rawPage) : 1, 1), totalPages);
    const start = (page - 1) * pageSize;
    return sendJson(res, 200, {
      items: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages,
      filters: {
        models,
        channels: [...channelOptions].map(([id, name]) => ({ id, name }))
      }
    });
  }
  if (req.method === "DELETE" && url.pathname === "/api/usage") {
    state.db.usage = [];
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  const usageMatch = url.pathname.match(/^\/api\/usage\/([^/]+)$/);
  if (usageMatch && req.method === "DELETE") {
    const before = state.db.usage.length;
    state.db.usage = state.db.usage.filter(record => record.id !== usageMatch[1]);
    if (state.db.usage.length === before) return sendError(res, 404, "Usage record not found");
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  sendError(res, 404, "Not found");
}

module.exports = {
  api
};
