const { usageRecord } = require("./state");
const { send, sendError, sendJson } = require("./http");
const { chatStreamToResponsesStream } = require("./bridge");
const { sortedCandidates } = require("./channels");
const { callChatCompletions, callImageEdits, callImageGenerations, callResponses } = require("./providers");
const {
  extractMultipartBoundary,
  extractMultipartModel,
  replaceMultipartModel,
  usageErrorDetail
} = require("./utils");

const jsonEndpointCallers = {
  responses: callResponses,
  chat_completions: callChatCompletions,
  image_generations: callImageGenerations
};

async function proxyResponses(req, res, body) {
  return proxyJsonEndpoint(req, res, body, "responses");
}

async function proxyChatCompletions(req, res, body) {
  return proxyJsonEndpoint(req, res, body, "chat_completions");
}

async function proxyImageGenerations(req, res, body) {
  return proxyJsonEndpoint(req, res, body, "image_generations");
}

async function proxyJsonEndpoint(req, res, body, endpoint) {
  const alias = body.model;
  if (!alias) return sendError(res, 400, "Missing model");
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for proxy model: ${alias}`);

  const errors = [];
  const callEndpoint = jsonEndpointCallers[endpoint];
  for (const { channel, model } of candidates) {
    try {
      const upstream = await callEndpoint(channel, model.id, body);
      if (upstream.stream) {
        res.writeHead(upstream.status, upstream.headers);
        let bytes = 0;
        try {
          const streamBody = upstream.bridge === "chat_to_responses"
            ? chatStreamToResponsesStream(upstream.body, upstream.model || model.id)
            : upstream.body;
          for await (const chunk of streamBody) {
            bytes += chunk.length;
            res.write(chunk);
          }
          res.end();
          usageRecord({ success: true, endpoint: req.url, bytes, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note });
        } catch (error) {
          usageRecord({ success: false, endpoint: req.url, bytes, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, error: error.message });
          if (!res.destroyed && !res.writableEnded) res.end();
        }
        return;
      }

      usageRecord({ success: true, endpoint: req.url, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note });
      return sendJson(res, upstream.status, upstream.body);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note
      });
      errors.push(detail);
      usageRecord({ success: false, endpoint: req.url, model: alias, sourceModel: model.id, ...detail, error: error.message });
    }
  }

  const firstError = errors[0] || {};
  sendError(res, 502, firstError.message || "All matching channels failed", {
    errors,
    upstreamStatus: firstError.upstreamStatus || null,
    upstreamBody: firstError.upstreamBody || null
  });
}

async function proxyImageEdits(req, res, rawBody) {
  const boundary = extractMultipartBoundary(req.headers["content-type"]);
  const alias = extractMultipartModel(rawBody, boundary);
  if (!alias) return sendError(res, 400, "Missing model");
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for proxy model: ${alias}`);

  const errors = [];
  for (const { channel, model } of candidates) {
    try {
      const upstreamBody = replaceMultipartModel(rawBody, boundary, model.id);
      const upstream = await callImageEdits(channel, upstreamBody, req);
      usageRecord({ success: true, endpoint: req.url, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note });
      return send(res, upstream.status, upstream.body, upstream.headers);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note
      });
      errors.push(detail);
      usageRecord({ success: false, endpoint: req.url, model: alias, sourceModel: model.id, ...detail, error: error.message });
    }
  }

  const firstError = errors[0] || {};
  sendError(res, 502, firstError.message || "All matching channels failed", {
    errors,
    upstreamStatus: firstError.upstreamStatus || null,
    upstreamBody: firstError.upstreamBody || null
  });
}

module.exports = {
  proxyResponses,
  proxyChatCompletions,
  proxyImageGenerations,
  proxyImageEdits
};
