const { URL } = require("url");
const { aliases } = require("./channels");
const { readBody, readRawBody, requireAuth, sendError, sendJson, staticFile } = require("./http");
const { api } = require("./api");
const { proxyChatCompletions, proxyImageEdits, proxyImageGenerations, proxyResponses } = require("./proxy");

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/") {
      res.writeHead(302, { location: "/admin" });
      return res.end();
    }
    if (url.pathname.startsWith("/admin") || url.pathname.startsWith("/assets/")) {
      return staticFile(req, res, url);
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (pathname === "/v1/models" || pathname === "/models") {
      if (!requireAuth(req, res)) return;
      const data = [...aliases().keys()].sort().map(id => ({ id, object: "model", created: 0, owned_by: "modelport" }));
      return sendJson(res, 200, { object: "list", data });
    }
    if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/responses")) {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      return await proxyResponses(req, res, body);
    }
    if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      return await proxyChatCompletions(req, res, body);
    }
    if (req.method === "POST" && (pathname === "/v1/images/generations" || pathname === "/images/generations")) {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      return await proxyImageGenerations(req, res, body);
    }
    if (req.method === "POST" && (pathname === "/v1/images/edits" || pathname === "/images/edits")) {
      if (!requireAuth(req, res)) return;
      const body = await readRawBody(req);
      return await proxyImageEdits(req, res, body);
    }
    sendError(res, 404, "Not found");
  } catch (error) {
    if (!res.headersSent) sendError(res, error.statusCode || 500, error.message || "Internal server error");
    else res.destroy(error);
  }
}

module.exports = {
  route
};
