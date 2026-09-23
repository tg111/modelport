const { openaiUrl } = require("./channels");
const { chatToResponsesBody, responsesToChatRequest } = require("./bridge");
const { preview, proxyHeaders, responseOutputText, upstreamError } = require("./utils");
const { state } = require("./state");
const {
  CODEX_UPSTREAM_BASE,
  codexUsageLimitFromBody,
  isCodexOAuthChannel,
  requestCodexImage,
  requestCodexResponse
} = require("./codex-oauth");
const { outboundFetch } = require("./outbound-proxy");

async function testChannel(channel, message = "你好", modelId) {
  if (channel.enabled === false) throw new Error("Channel is disabled");
  const models = channel.models || [];
  const model = modelId
    ? models.find(item => item.id === modelId)
    : models.find(item => item.enabled) || models[0];
  if (modelId && !model) throw new Error("Selected model was not found for this channel.");
  if (!model) throw new Error("No model found for this channel. Please fetch models first.");
  const body = {
    model: model.alias || model.id,
    input: message || "你好",
    ...(isCodexOAuthChannel(channel) ? { stream: true } : {})
  };
  const upstream = await callResponses(channel, model.id, body);
  return { model, upstream: upstream.stream ? await collectTestStream(upstream) : upstream };
}

async function collectTestStream(upstream) {
  const decoder = new TextDecoder();
  let remainder = "";
  let completedResponse = null;
  let usage = null;
  let outputText = "";
  let doneText = "";

  const processEvent = event => {
    const data = event.split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const eventType = payload.type || event.match(/^event:\s*(.+)$/m)?.[1] || "";
    const error = payload.error || (eventType === "response.failed" ? payload.response?.error : null);
    if (error) {
      throw upstreamError(error.message || "Upstream streaming request failed", {
        upstreamStatus: upstream.status,
        upstreamBody: preview(payload)
      });
    }

    const response = payload.response?.response || payload.response;
    if (response && typeof response === "object") {
      completedResponse = response;
      if (response.usage) usage = response.usage;
    }
    if (payload.usage) usage = payload.usage;
    if (eventType === "response.output_text.delta" && typeof payload.delta === "string") outputText += payload.delta;
    if (eventType === "response.output_text.done" && typeof payload.text === "string") doneText = payload.text;
  };

  const processBufferedEvents = flush => {
    const events = remainder.split(/\r?\n\r?\n/);
    remainder = flush ? "" : events.pop() || "";
    for (const event of events) processEvent(event);
    if (flush && remainder) processEvent(remainder);
  };

  try {
    for await (const chunk of upstream.body) {
      remainder += decoder.decode(chunk, { stream: true });
      processBufferedEvents(false);
    }
    remainder += decoder.decode();
    processBufferedEvents(true);
  } finally {
    upstream.cancelTimeout?.();
  }

  const body = { ...(completedResponse || {}) };
  const finalText = responseOutputText(body) || doneText || outputText;
  if (finalText && !responseOutputText(body)) body.output_text = finalText;
  if (usage && !body.usage) body.usage = usage;
  return { ...upstream, stream: false, body };
}

async function callResponses(channel, modelId, body) {
  if (isCodexOAuthChannel(channel)) return callCodexOAuthResponses(channel, modelId, body);
  if (channel.protocol === "chat") return callChatBackedResponses(channel, modelId, body);
  return callJsonEndpoint(channel, "/responses", modelId, body);
}

async function callChatBackedResponses(channel, modelId, body) {
  const chatBody = responsesToChatRequest(body, modelId);
  const upstream = await callJsonEndpoint(channel, "/chat/completions", modelId, chatBody);
  if (upstream.stream) return { ...upstream, bridge: "chat_to_responses", model: modelId };
  return { ...upstream, body: chatToResponsesBody(upstream.body, modelId) };
}

async function callChatCompletions(channel, modelId, body) {
  if (isCodexOAuthChannel(channel)) {
    throw upstreamError("Codex OAuth channels support the Responses API only", { upstreamStatus: 400 });
  }
  return callJsonEndpoint(channel, "/chat/completions", modelId, body);
}

async function callImageGenerations(channel, modelId, body) {
  if (isCodexOAuthChannel(channel)) {
    return callCodexOAuthImage(channel, modelId, body);
  }
  const endpointPath = "/images/generations";
  return callJsonEndpoint(channel, endpointPath, modelId, body, {
    timeoutMs: state.db.settings.imageTimeoutSeconds * 1000,
    timeoutLabel: "image request"
  });
}

async function callImageEdits(channel, rawBody, req, modelId) {
  if (isCodexOAuthChannel(channel)) {
    return callCodexOAuthImageEdit(channel, modelId, rawBody, req);
  }
  return callRawEndpoint(channel, "/images/edits", rawBody, req, {
    timeoutMs: state.db.settings.imageTimeoutSeconds * 1000,
    timeoutLabel: "image request"
  });
}

function requestTimer(timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel: () => clearTimeout(timer)
  };
}

function timeoutError(timeoutMs, timeoutLabel, upstreamUrl) {
  return upstreamError(`Upstream ${timeoutLabel} timed out after ${timeoutMs / 1000} seconds`, {
    isTimeout: true,
    timeoutMs,
    upstreamUrl
  });
}

function retryAfterMs(res) {
  const value = res.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function codexUpstreamError(res, data, upstreamUrl) {
  const usageLimit = codexUsageLimitFromBody(data);
  const resetAt = Date.parse(usageLimit?.resetAt || "");
  const resetDelay = Number.isFinite(resetAt) ? Math.max(0, resetAt - Date.now()) : 0;
  return upstreamError(data?.error?.message || `Upstream request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(data),
    retryAfterMs: Math.max(retryAfterMs(res), resetDelay),
    ...(usageLimit ? { codexUsageLimit: usageLimit } : {})
  });
}

function parseJsonOrText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callCodexOAuthResponses(channel, modelId, body) {
  return callCodexOAuthRequest(channel, modelId, body, {
    timeoutMs: state.db.settings.textTimeoutSeconds * 1000,
    timeoutLabel: "text request",
    upstreamUrl: `${CODEX_UPSTREAM_BASE}/responses`,
    request: requestCodexResponse
  });
}

async function callCodexOAuthImage(channel, modelId, body) {
  return callCodexOAuthRequest(channel, modelId, body, {
    timeoutMs: state.db.settings.imageTimeoutSeconds * 1000,
    timeoutLabel: "image request",
    upstreamUrl: `${CODEX_UPSTREAM_BASE}/images/generations`,
    request: requestCodexImage
  });
}

async function callCodexOAuthImageEdit(channel, modelId, rawBody, req) {
  const body = await codexOAuthImageEditBody(rawBody, req, modelId);
  return callCodexOAuthRequest(channel, modelId, body, {
    timeoutMs: state.db.settings.imageTimeoutSeconds * 1000,
    timeoutLabel: "image request",
    upstreamUrl: `${CODEX_UPSTREAM_BASE}/images/edits`,
    request: (oauthChannel, oauthModelId, requestBody, signal) => requestCodexImage(
      oauthChannel,
      oauthModelId,
      requestBody,
      signal,
      "edits"
    )
  });
}

async function codexOAuthImageEditBody(rawBody, req, modelId) {
  const contentType = String(req?.headers?.["content-type"] || req?.headers?.["Content-Type"] || "").trim();
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    throw upstreamError("Codex OAuth image edits require multipart/form-data", { upstreamStatus: 400 });
  }

  let form;
  try {
    form = await new Response(rawBody, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    throw upstreamError(`Invalid multipart image edit request: ${error.message}`, { upstreamStatus: 400 });
  }

  const body = { model: modelId };
  const imageFiles = [];
  let maskFile = null;
  for (const [name, value] of form.entries()) {
    if (name === "model" || name === "stream") continue;
    if (isCodexImageEditFile(value)) {
      if (name === "image" || name === "image[]") imageFiles.push(value);
      else if (name === "mask" && !maskFile) maskFile = value;
      continue;
    }
    setCodexImageEditFormValue(body, name, value);
  }

  try {
    if (imageFiles.length) {
      body.images = await Promise.all(imageFiles.map(async file => ({ image_url: await codexImageEditDataUrl(file) })));
    }
    if (maskFile) {
      body.mask = {
        ...(body.mask && typeof body.mask === "object" ? body.mask : {}),
        image_url: await codexImageEditDataUrl(maskFile)
      };
    }
  } catch (error) {
    throw upstreamError(`Unable to read image edit upload: ${error.message}`, { upstreamStatus: 400 });
  }

  return body;
}

function isCodexImageEditFile(value) {
  return Boolean(value && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.name === "string");
}

function setCodexImageEditFormValue(body, name, value) {
  const text = String(value || "").trim();
  if (name === "mask[file_id]" || name === "mask[image_url]") {
    body.mask = body.mask && typeof body.mask === "object" ? body.mask : {};
    body.mask[name === "mask[file_id]" ? "file_id" : "image_url"] = text;
    return;
  }
  const parsed = ["n", "output_compression", "partial_images"].includes(name) && /^-?\d+$/.test(text)
    ? Number(text)
    : text;
  if (!Object.hasOwn(body, name)) {
    body[name] = parsed;
    return;
  }
  body[name] = Array.isArray(body[name]) ? [...body[name], parsed] : [body[name], parsed];
}

async function codexImageEditDataUrl(file) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const type = String(file.type || "").trim() || codexImageMimeType(file.name);
  return `data:${type};base64,${buffer.toString("base64")}`;
}

function codexImageMimeType(name) {
  const extension = String(name || "").trim().toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

async function callCodexOAuthRequest(channel, modelId, body, options) {
  const { timeoutMs, timeoutLabel, upstreamUrl, request } = options;
  const timeout = requestTimer(timeoutMs);
  let res;
  try {
    res = await request(channel, modelId, body, timeout.signal);
  } catch (error) {
    timeout.cancel();
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    throw error;
  }

  if (body.stream === true) {
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch (error) {
        timeout.cancel();
        if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
      }
      timeout.cancel();
      throw codexUpstreamError(res, parseJsonOrText(text), upstreamUrl);
    }
    return {
      stream: true,
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "cache-control": res.headers.get("cache-control") || "no-cache",
        connection: res.headers.get("connection") || "keep-alive"
      },
      body: timeoutAwareBody(res.body, timeout, timeoutMs, timeoutLabel, upstreamUrl),
      cancelTimeout: timeout.cancel
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (error) {
    timeout.cancel();
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    data = {};
  }
  timeout.cancel();
  if (!res.ok) throw codexUpstreamError(res, data, upstreamUrl);
  return { stream: false, status: res.status, body: data };
}

async function* timeoutAwareBody(body, timeout, timeoutMs, timeoutLabel, upstreamUrl) {
  try {
    for await (const chunk of body) yield chunk;
  } catch (error) {
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    throw error;
  } finally {
    timeout.cancel();
  }
}

async function callJsonEndpoint(channel, endpointPath, modelId, body, options = {}) {
  const upstreamBody = { ...body, model: modelId };
  if (endpointPath === "/chat/completions" && body.stream === true && upstreamBody.stream_options === undefined) {
    upstreamBody.stream_options = { include_usage: true };
  }
  const upstreamUrl = openaiUrl(channel.apiBase, endpointPath);
  const timeoutMs = options.timeoutMs || state.db.settings.textTimeoutSeconds * 1000;
  const timeoutLabel = options.timeoutLabel || "text request";
  const timeout = requestTimer(timeoutMs);
  let res;
  try {
    res = await outboundFetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify(upstreamBody),
      signal: timeout.signal
    });
  } catch (error) {
    timeout.cancel();
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    throw error;
  }

  if (body.stream === true) {
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch (error) {
        timeout.cancel();
        if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
      }
      timeout.cancel();
      throw upstreamError(`Upstream request failed: ${res.status}`, {
        upstreamStatus: res.status,
        upstreamUrl,
        upstreamBody: preview(text),
        retryAfterMs: retryAfterMs(res)
      });
    }
    return {
      stream: true,
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "cache-control": res.headers.get("cache-control") || "no-cache",
        connection: res.headers.get("connection") || "keep-alive"
      },
      body: timeoutAwareBody(res.body, timeout, timeoutMs, timeoutLabel, upstreamUrl),
      cancelTimeout: timeout.cancel
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (error) {
    timeout.cancel();
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    data = {};
  }
  timeout.cancel();
  if (!res.ok) throw upstreamError(data.error?.message || `Upstream request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(data),
    retryAfterMs: retryAfterMs(res)
  });
  return { stream: false, status: res.status, body: data };
}

async function callRawEndpoint(channel, endpointPath, rawBody, req, options = {}) {
  const upstreamUrl = openaiUrl(channel.apiBase, endpointPath);
  const timeoutMs = options.timeoutMs || state.db.settings.textTimeoutSeconds * 1000;
  const timeoutLabel = options.timeoutLabel || "request";
  const timeout = requestTimer(timeoutMs);
  let res;
  try {
    res = await outboundFetch(upstreamUrl, {
      method: "POST",
      headers: proxyHeaders(req, { authorization: `Bearer ${channel.apiKey}` }),
      body: rawBody,
      signal: timeout.signal
    });
  } catch (error) {
    timeout.cancel();
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    throw error;
  }

  const type = res.headers.get("content-type") || "application/json; charset=utf-8";
  let text;
  try {
    text = await res.text();
  } catch (error) {
    timeout.cancel();
    if (timeout.timedOut()) throw timeoutError(timeoutMs, timeoutLabel, upstreamUrl);
    throw error;
  }
  timeout.cancel();
  let body = text;
  if (type.toLowerCase().includes("application/json")) {
    body = text ? JSON.parse(text) : {};
  }
  if (!res.ok) throw upstreamError(body?.error?.message || `Upstream request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(body),
    retryAfterMs: retryAfterMs(res)
  });
  return { stream: false, status: res.status, body, headers: { "content-type": type } };
}

module.exports = {
  testChannel,
  callResponses,
  callChatCompletions,
  callImageGenerations,
  callImageEdits,
  responseOutputText
};
