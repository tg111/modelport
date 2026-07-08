function normalizeBase(apiBase) {
  return String(apiBase || "").trim().replace(/\/+$/, "");
}

function estimateTokens(body) {
  if (!body) return 0;
  if (body.usage?.total_tokens) return body.usage.total_tokens;
  const usage = body.usage || body.usageMetadata;
  return Number(usage?.input_tokens || 0)
    + Number(usage?.output_tokens || 0)
    + Number(usage?.promptTokenCount || 0)
    + Number(usage?.candidatesTokenCount || 0);
}

function preview(value, limit = 1200) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function upstreamError(message, detail = {}) {
  const error = new Error(message);
  Object.assign(error, detail);
  return error;
}

function usageErrorDetail(error, fallback = {}) {
  return {
    ...fallback,
    message: error.message,
    upstreamStatus: error.upstreamStatus || fallback.upstreamStatus || null,
    upstreamUrl: error.upstreamUrl || fallback.upstreamUrl || null,
    upstreamBody: error.upstreamBody || fallback.upstreamBody || null
  };
}

function responseOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const output = Array.isArray(body?.output) ? body.output : [];
  return output.flatMap(item => Array.isArray(item.content) ? item.content : [])
    .map(part => part.text || "")
    .join("");
}

function contentType(req) {
  return String(req.headers["content-type"] || "");
}

function isJsonRequest(req) {
  return contentType(req).toLowerCase().includes("application/json");
}

function isMultipartRequest(req) {
  return contentType(req).toLowerCase().includes("multipart/form-data");
}

function extractMultipartBoundary(type) {
  const match = String(type || "").match(/(?:^|;)\s*boundary=(?:("[^"]+")|([^;]+))/i);
  if (!match) return "";
  return String(match[1] || match[2] || "").replace(/^"|"$/g, "");
}

function extractMultipartModel(rawBody, boundary) {
  if (!boundary) return "";
  const text = rawBody.toString("latin1");
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`--${escaped}\\r?\\n[\\s\\S]*?name="model"[\\s\\S]*?\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n--${escaped}(?:--)?\\r?\\n)`, "i");
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

function replaceMultipartModel(rawBody, boundary, model) {
  if (!boundary) return rawBody;
  const text = rawBody.toString("latin1");
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(--${escaped}\\r?\\n[\\s\\S]*?name="model"[\\s\\S]*?\\r?\\n\\r?\\n)([\\s\\S]*?)(?=\\r?\\n--${escaped}(?:--)?\\r?\\n)`, "i");
  if (!pattern.test(text)) return rawBody;
  return Buffer.from(text.replace(pattern, `$1${model}`), "latin1");
}

function proxyHeaders(req, extra = {}) {
  const headers = { ...extra };
  const pass = ["content-type", "accept", "openai-beta", "openai-organization", "openai-project"];
  for (const name of pass) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }
  return headers;
}

module.exports = {
  normalizeBase,
  estimateTokens,
  preview,
  upstreamError,
  usageErrorDetail,
  responseOutputText,
  contentType,
  isJsonRequest,
  isMultipartRequest,
  extractMultipartBoundary,
  extractMultipartModel,
  replaceMultipartModel,
  proxyHeaders
};
