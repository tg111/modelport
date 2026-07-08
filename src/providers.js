const { openaiUrl } = require("./channels");
const { chatToResponsesBody, responsesToChatRequest } = require("./bridge");
const { preview, proxyHeaders, responseOutputText, upstreamError } = require("./utils");

async function testChannel(channel, message = "你好") {
  if (channel.enabled === false) throw new Error("Channel is disabled");
  const model = (channel.models || []).find(item => item.enabled) || (channel.models || [])[0];
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
  return callJsonEndpoint(channel, "/images/generations", modelId, body);
}

async function callImageEdits(channel, rawBody, req) {
  return callRawEndpoint(channel, "/images/edits", rawBody, req);
}

async function callJsonEndpoint(channel, endpointPath, modelId, body) {
  const upstreamBody = { ...body, model: modelId };
  const upstreamUrl = openaiUrl(channel.apiBase, endpointPath);
  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
    body: JSON.stringify(upstreamBody)
  });

  if (body.stream === true) {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw upstreamError(`Upstream request failed: ${res.status}`, {
        upstreamStatus: res.status,
        upstreamUrl,
        upstreamBody: preview(text)
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
      body: res.body
    };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw upstreamError(data.error?.message || `Upstream request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(data)
  });
  return { stream: false, status: res.status, body: data };
}

async function callRawEndpoint(channel, endpointPath, rawBody, req) {
  const upstreamUrl = openaiUrl(channel.apiBase, endpointPath);
  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers: proxyHeaders(req, { authorization: `Bearer ${channel.apiKey}` }),
    body: rawBody
  });

  const type = res.headers.get("content-type") || "application/json; charset=utf-8";
  const text = await res.text().catch(() => "");
  let body = text;
  if (type.toLowerCase().includes("application/json")) {
    body = text ? JSON.parse(text) : {};
  }
  if (!res.ok) throw upstreamError(body?.error?.message || `Upstream request failed: ${res.status}`, {
    upstreamStatus: res.status,
    upstreamUrl,
    upstreamBody: preview(body)
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
