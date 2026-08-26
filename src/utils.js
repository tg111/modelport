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

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return {};
  const numberAt = (...values) => {
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return undefined;
  };
  const explicitInputTokens = numberAt(usage.input_tokens, usage.prompt_tokens, usage.inputTokenCount);
  const promptTokenCount = numberAt(usage.promptTokenCount);
  const toolUsePromptTokenCount = numberAt(usage.toolUsePromptTokenCount, usage.tool_use_prompt_token_count);
  const inputTokens = explicitInputTokens !== undefined
    ? explicitInputTokens
    : promptTokenCount !== undefined || toolUsePromptTokenCount !== undefined
      ? (promptTokenCount || 0) + (toolUsePromptTokenCount || 0)
      : undefined;
  const outputTokens = numberAt(usage.output_tokens, usage.completion_tokens, usage.outputTokenCount, usage.candidatesTokenCount);
  const reportedTotalTokens = numberAt(usage.total_tokens, usage.totalTokenCount);
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.completion_tokens_details || {};
  const cachedTokens = numberAt(
    inputDetails.cached_tokens,
    inputDetails.cache_read_tokens,
    usage.cached_tokens,
    usage.cache_read_tokens,
    usage.cachedContentTokenCount
  );
  const cacheCreationTokens = numberAt(
    inputDetails.cache_creation_tokens,
    inputDetails.cache_creation_input_tokens,
    usage.cache_creation_tokens
  );
  const cacheWriteTokens = numberAt(inputDetails.cache_write_tokens, usage.cache_write_tokens);
  const reasoningTokens = numberAt(
    outputDetails.reasoning_tokens,
    usage.reasoning_tokens,
    usage.thoughtsTokenCount
  );
  const result = {};
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cachedTokens !== undefined) {
    result.cachedTokens = cachedTokens;
    result.cacheReadTokens = cachedTokens;
  }
  if (cacheCreationTokens !== undefined) result.cacheCreationTokens = cacheCreationTokens;
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens;
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;

  const componentTotal = (inputTokens || 0) + (outputTokens || 0);
  if (reportedTotalTokens !== undefined && (reportedTotalTokens > 0 || componentTotal === 0)) {
    result.totalTokens = reportedTotalTokens;
  } else if (inputTokens !== undefined || outputTokens !== undefined) {
    result.totalTokens = componentTotal;
    result.totalTokensDerived = true;
  }

  if (Object.keys(result).length) {
    result.usageSource = "upstream";
    if (result.totalTokens !== undefined && !result.totalTokensDerived && componentTotal > 0 && result.totalTokens !== componentTotal) {
      result.usageQuality = "inconsistent";
    } else if (result.totalTokensDerived) {
      result.usageQuality = "derived";
    } else {
      result.usageQuality = "reported";
    }
  }
  return result;
}

function estimateInputUsage(body, model = "") {
  if (!body || typeof body !== "object") return {};
  let encoder;
  try {
    const { encodingForModel, getEncoding } = require("js-tiktoken");
    try {
      encoder = encodingForModel(String(model || "gpt-4o"));
    } catch {
      encoder = getEncoding("cl100k_base");
    }
  } catch {
    return {};
  }

  const segments = [];
  const add = value => {
    if (typeof value === "string" && value.trim()) segments.push(value.trim());
  };
  const addContent = content => {
    if (typeof content === "string") return add(content);
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (typeof part === "string") add(part);
      else if (part && typeof part === "object") add(part.text ?? part.input_text ?? part.output_text ?? part.content);
    }
  };
  const addInputItem = item => {
    if (typeof item === "string") return add(item);
    if (!item || typeof item !== "object") return;
    add(item.role);
    add(item.name);
    add(item.arguments);
    add(item.output);
    add(item.text);
    addContent(item.content);
  };
  add(body.instructions);
  if (Array.isArray(body.input)) {
    for (const item of body.input) addInputItem(item);
  } else {
    addContent(body.input);
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      add(message?.role);
      addContent(message?.content);
      for (const call of message?.tool_calls || []) {
        add(call?.function?.name);
        add(call?.function?.arguments);
      }
    }
  }
  for (const tool of body.tools || []) {
    add(tool?.name);
    add(tool?.description);
    if (tool?.parameters !== undefined) add(JSON.stringify(tool.parameters));
    if (tool?.function) {
      add(tool.function.name);
      add(tool.function.description);
      if (tool.function.parameters !== undefined) add(JSON.stringify(tool.function.parameters));
    }
  }
  if (body.response_format !== undefined) add(JSON.stringify(body.response_format));
  if (body.text?.format !== undefined) add(JSON.stringify(body.text.format));
  if (!segments.length) return {};
  const inputTokens = encoder.encode(segments.join("\n")).length;
  return {
    inputTokens,
    totalTokens: inputTokens,
    usageSource: "estimated",
    usageQuality: "estimated"
  };
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

function clientIp(req) {
  const forwarded = String(req.headers?.forwarded || "");
  const forwardedFor = forwarded.match(/(?:^|[,;])\s*for=(?:"?\[([^\]]+)\](?::\d+)?"?|"?([^;,\s"]+)"?)/i);
  const raw = forwardedFor?.[1]
    || forwardedFor?.[2]
    || String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim()
    || String(req.headers?.["x-real-ip"] || "").trim()
    || req.socket?.remoteAddress
    || "";
  const normalized = raw.replace(/^::ffff:/, "").replace(/^"|"$/g, "");
  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(normalized)
    ? normalized.slice(0, normalized.lastIndexOf(":"))
    : normalized;
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
  normalizeUsage,
  estimateInputUsage,
  preview,
  upstreamError,
  usageErrorDetail,
  clientIp,
  responseOutputText,
  contentType,
  isJsonRequest,
  isMultipartRequest,
  extractMultipartBoundary,
  extractMultipartModel,
  replaceMultipartModel,
  proxyHeaders
};
