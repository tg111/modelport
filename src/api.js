const { state, saveDb, usageRecord } = require("./state");
const { readBody, requireAuth, sendError, sendJson } = require("./http");
const {
  fetchModels,
  mergeModels,
  publicChannel,
  sanitizeChannel,
  sanitizeModels
} = require("./channels");
const { responseOutputText, testChannel } = require("./providers");

async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    return sendJson(res, body.apiKey === state.apiKey ? 200 : 401, { ok: body.apiKey === state.apiKey });
  }
  if (!requireAuth(req, res)) return;

  if (req.method === "GET" && url.pathname === "/api/channels") {
    return sendJson(res, 200, state.db.channels.map(publicChannel));
  }
  if (req.method === "POST" && url.pathname === "/api/channels") {
    const body = await readBody(req);
    if (!body.apiBase) return sendError(res, 400, "apiBase is required");
    const channel = sanitizeChannel(body);
    state.db.channels.unshift(channel);
    saveDb();
    return sendJson(res, 201, publicChannel(channel));
  }
  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)(?:\/(models|fetch-models|test|enabled))?$/);
  if (channelMatch) {
    const channel = state.db.channels.find(item => item.id === channelMatch[1]);
    if (!channel) return sendError(res, 404, "Channel not found");
    const action = channelMatch[2];
    if (req.method === "GET" && !action) {
      return sendJson(res, 200, publicChannel(channel, { includeKey: true }));
    }
    if (req.method === "PUT" && !action) {
      const body = await readBody(req);
      Object.assign(channel, sanitizeChannel(body, channel));
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
      try {
        const result = await testChannel(channel, testMessage);
        usageRecord({
          success: true,
          endpoint: "/api/channels/:id/test",
          model: result.model.alias || result.model.id,
          sourceModel: result.model.id,
          channelId: channel.id,
          channelNote: channel.note,
          request: testMessage
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
        const model = (channel.models || []).find(item => item.enabled) || (channel.models || [])[0] || {};
        usageRecord({
          success: false,
          endpoint: "/api/channels/:id/test",
          model: model.alias || model.id || "",
          sourceModel: model.id || "",
          channelId: channel.id,
          channelNote: channel.note,
          request: testMessage,
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
    const rows = state.db.usage.filter(record => {
      if (status === "success") return record.success === true;
      if (status === "failed") return record.success === false;
      return true;
    });
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(Number.isFinite(rawPage) ? Math.floor(rawPage) : 1, 1), totalPages);
    const start = (page - 1) * pageSize;
    return sendJson(res, 200, {
      items: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages
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
