const fs = require("fs");
const path = require("path");
const { PUBLIC_DIR, state } = require("./state");

const jsonType = { "content-type": "application/json; charset=utf-8" };
const textType = { "content-type": "text/plain; charset=utf-8" };
const htmlType = { "content-type": "text/html; charset=utf-8" };

function send(res, status, body, headers = jsonType) {
  if (res.headersSent) return;
  res.writeHead(status, headers);
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendJson(res, status, body) {
  send(res, status, body, jsonType);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, ...extra } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function authKey(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers["x-api-key"] || "";
}

function requireAuth(req, res) {
  if (authKey(req) === state.apiKey) return true;
  sendError(res, 401, "Unauthorized");
  return false;
}

function staticFile(req, res, url) {
  let file = url.pathname === "/admin" ? "admin.html" : url.pathname.replace(/^\/assets\//, "");
  const fullPath = path.resolve(PUBLIC_DIR, file);
  if (!fullPath.startsWith(PUBLIC_DIR) || !fs.existsSync(fullPath)) return sendError(res, 404, "Not found");
  const ext = path.extname(fullPath);
  const type = ext === ".html" ? htmlType : ext === ".css" ? { "content-type": "text/css; charset=utf-8" } : ext === ".js" ? { "content-type": "application/javascript; charset=utf-8" } : textType;
  res.writeHead(200, type);
  fs.createReadStream(fullPath)
    .on("error", error => {
      if (!res.headersSent) sendError(res, 500, error.message || "Failed to read file");
      else res.destroy(error);
    })
    .pipe(res);
}

module.exports = {
  send,
  sendJson,
  sendError,
  readBody,
  readRawBody,
  requireAuth,
  staticFile
};
