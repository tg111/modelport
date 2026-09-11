const { state, saveDb, usageRecord } = require("./state");
const crypto = require("crypto");
const { readBody, requireAuth, sendError, sendJson } = require("./http");
const {
  detectAndUpdateProtocol,
  fetchModels,
  markProtocolDetecting,
  mergeModels,
  calculateCacheStats,
  publicChannel,
  sanitizeChannel,
  sanitizeModels
} = require("./channels");
const { responseOutputText, testChannel } = require("./providers");
const { clientIp, normalizeUsage } = require("./utils");
const { validateSettings } = require("./settings");
const { recordChannelFailure, recordChannelSuccess, resetChannelCircuit } = require("./circuit");
const {
  CODEX_UPSTREAM_BASE,
  cancelCodexAuthorization,
  completeCodexAuthorization,
  defaultCodexModels,
  finalizeCodexAuthorization,
  getCodexAuthorization,
  refreshCodexQuota,
  sessionPublic,
  startCodexAuthorization,
  storedOAuthInfo
} = require("./codex-oauth");

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

async function syncCodexModels(channel) {
  try {
    const models = await fetchModels(channel);
    if (models.length) mergeModels(channel, models);
  } catch (error) {
    channel.codexOAuth.modelSyncError = error.message || "Codex model fetch failed";
  }
}

async function syncCodexQuota(channel) {
  try {
    return await refreshCodexQuota(channel);
  } catch (error) {
    channel.codexOAuth.quotaError = error.message || "Codex quota fetch failed";
    channel.updatedAt = new Date().toISOString();
    return null;
  }
}

async function saveCodexOAuthChannel(session) {
  if (!session || session.status !== "completed") return null;
  if (session.channelId) return state.db.channels.find(channel => channel.id === session.channelId) || null;

  const target = session.targetChannelId
    ? state.db.channels.find(channel => channel.id === session.targetChannelId && channel.authType === "codex_oauth")
    : null;
  const channelId = target?.id || crypto.randomUUID();
  const credentials = finalizeCodexAuthorization(session.id, channelId);
  if (!credentials) return state.db.channels.find(channel => channel.id === channelId) || null;

  const now = new Date().toISOString();
  if (target) {
    target.codexOAuth = storedOAuthInfo(credentials, { status: "active", lastRefreshAt: now });
    target.note = session.note || target.note || `Codex · ${credentials.email}`;
    target.providerLink = "https://chatgpt.com";
    target.apiBase = CODEX_UPSTREAM_BASE;
    target.apiKey = "";
    target.protocol = "responses";
    target.updatedAt = now;
    resetChannelCircuit(target);
    await syncCodexModels(target);
    await syncCodexQuota(target);
    saveDb();
    return target;
  }

  const models = defaultCodexModels();
  const channel = {
    id: channelId,
    authType: "codex_oauth",
    apiBase: CODEX_UPSTREAM_BASE,
    apiKey: "",
    protocol: "responses",
    note: session.note || `Codex · ${credentials.email}`,
    providerLink: "https://chatgpt.com",
    enabled: true,
    models,
    testModelId: models[0]?.id || "",
    codexOAuth: storedOAuthInfo(credentials, { status: "active", lastRefreshAt: now }),
    createdAt: now,
    updatedAt: now
  };
  state.db.channels.unshift(channel);
  await syncCodexModels(channel);
  await syncCodexQuota(channel);
  saveDb();
  return channel;
}

async function codexOAuthStatusPayload(id) {
  const session = getCodexAuthorization(id);
  if (!session) return null;
  const channel = await saveCodexOAuthChannel(session);
  const latest = getCodexAuthorization(id) || session;
  return {
    ...sessionPublic(latest),
    ...(channel ? { channel: publicChannel(channel) } : {})
  };
}

async function completeCodexOAuthCallback(sessionId, redirectUrl) {
  await completeCodexAuthorization(sessionId, redirectUrl);
  return codexOAuthStatusPayload(sessionId);
}

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    return sendJson(res, body.apiKey === state.apiKey ? 200 : 401, { ok: body.apiKey === state.apiKey });
  }
  if (!requireAuth(req, res)) return;

  if (req.method === "POST" && url.pathname === "/api/oauth/codex/start") {
    try {
      const body = await readBody(req);
      const targetChannelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
      if (targetChannelId) {
        const channel = state.db.channels.find(item => item.id === targetChannelId);
        if (!channel || channel.authType !== "codex_oauth") return sendError(res, 404, "Codex OAuth channel not found");
      }
      const session = startCodexAuthorization({
        note: typeof body.note === "string" ? body.note.trim() : "",
        targetChannelId
      });
      return sendJson(res, 201, session);
    } catch (error) {
      return sendError(res, error.statusCode || 502, error.message || "Failed to start Codex OAuth");
    }
  }

  const oauthMatch = url.pathname.match(/^\/api\/oauth\/codex\/([^/]+)(?:\/(callback|cancel))?$/);
  if (oauthMatch) {
    const sessionId = oauthMatch[1];
    const action = oauthMatch[2];
    if (req.method === "POST" && action === "callback") {
      try {
        const body = await readBody(req);
        const payload = await completeCodexOAuthCallback(sessionId, body.redirectUrl);
        return sendJson(res, 200, payload);
      } catch (error) {
        return sendError(res, error.statusCode || 502, error.message || "Failed to complete Codex OAuth");
      }
    }
    if (req.method === "POST" && action === "cancel") {
      if (!cancelCodexAuthorization(sessionId)) return sendError(res, 404, "Codex OAuth session not found");
      return sendJson(res, 200, await codexOAuthStatusPayload(sessionId));
    }
    if (req.method === "GET" && !action) {
      const payload = await codexOAuthStatusPayload(sessionId);
      if (!payload) return sendError(res, 404, "Codex OAuth session not found");
      return sendJson(res, 200, payload);
    }
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    return sendJson(res, 200, state.db.settings);
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readBody(req);
    state.db.settings = validateSettings(body);
    saveDb();
    return sendJson(res, 200, state.db.settings);
  }

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
  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)(?:\/(models|fetch-models|quota|test|test-model|enabled|circuit-reset))?$/);
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
    if (req.method === "POST" && action === "quota") {
      if (channel.authType !== "codex_oauth") return sendError(res, 400, "Quota refresh is only available for Codex OAuth channels");
      try {
        await refreshCodexQuota(channel);
        saveDb();
        return sendJson(res, 200, publicChannel(channel));
      } catch (error) {
        channel.codexOAuth.quotaError = error.message || "Codex quota fetch failed";
        channel.updatedAt = new Date().toISOString();
        saveDb();
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
        recordChannelSuccess(channel);
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
          ttftSeconds: null,
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
        recordChannelFailure(channel, error);
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
          ttftSeconds: null,
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
    if (req.method === "POST" && action === "circuit-reset") {
      resetChannelCircuit(channel);
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
      cacheStats: calculateCacheStats(rows),
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
  api,
  completeCodexOAuthCallback
};
