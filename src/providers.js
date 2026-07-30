const { openaiUrl } = require("./channels");
const { chatToResponsesBody, responsesToChatRequest } = require("./bridge");
const { preview, proxyHeaders, responseOutputText, upstreamError } = require("./utils");
const { state } = require("./state");

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
    input: message || "你好"
  };
  const upstream = await callResponses(channel, model.id, body);
  return { model, upstream };
}

async function callResponses(channel, modelId, body) {
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
  return callJsonEndpoint(channel, "/chat/completions", modelId, body);
}

async function callImageGenerations(channel, modelId, body) {
  const endpointPath = "/images/generations";
  return callJsonEndpoint(channel, endpointPath, modelId, body, {
    timeoutMs: state.db.settings.imageTimeoutSeconds * 1000,
    timeoutLabel: "image request"
  });
}

async function callImageEdits(channel, rawBody, req) {
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
    res = await fetch(upstreamUrl, {
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
    res = await fetch(upstreamUrl, {
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
