const { usageRecord } = require("./state");
const { send, sendError, sendJson } = require("./http");
const { chatStreamToResponsesStream } = require("./bridge");
const { sortedCandidates } = require("./channels");
const { callChatCompletions, callImageEdits, callImageGenerations, callResponses } = require("./providers");
const {
  extractMultipartBoundary,
  extractMultipartModel,
  replaceMultipartModel,
  clientIp,
  usageErrorDetail,
  normalizeUsage
} = require("./utils");

const jsonEndpointCallers = {
  responses: callResponses,
  chat_completions: callChatCompletions,
  image_generations: callImageGenerations
};

function elapsedSeconds(startedAt) {
  return Number(((Date.now() - startedAt) / 1000).toFixed(1));
}

function elapsedSecondsBetween(startedAt, finishedAt) {
  return finishedAt === null ? null : Number(((finishedAt - startedAt) / 1000).toFixed(1));
}

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
  const ip = clientIp(req);
  if (!alias) return sendError(res, 400, "Missing model");
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for proxy model: ${alias}`);

  const errors = [];
  const callEndpoint = jsonEndpointCallers[endpoint];
  for (const { channel, model } of candidates) {
    const startedAt = Date.now();
    try {
      const upstream = await callEndpoint(channel, model.id, body);
      if (upstream.stream) {
        res.writeHead(upstream.status, upstream.headers);
        let bytes = 0;
        let streamText = "";
        let usage = {};
        let firstTokenAt = null;
        const streamDecoder = new TextDecoder();
        const readUsageEvents = text => {
          const events = text.split(/\r?\n\r?\n/);
          const remainder = events.pop() || "";
          for (const event of events) {
            const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n").trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              const hasChatToken = typeof delta?.content === "string" && delta.content.length > 0
                || (delta?.tool_calls || []).some(item => typeof item.function?.arguments === "string" && item.function.arguments.length > 0);
              const hasResponseToken = parsed.type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta.length > 0
                || parsed.type === "response.function_call_arguments.delta" && typeof parsed.delta === "string" && parsed.delta.length > 0;
              if (firstTokenAt === null && (hasChatToken || hasResponseToken)) firstTokenAt = Date.now();
              const candidateUsage = parsed.usage || parsed.response?.usage || parsed.response?.response?.usage;
              if (candidateUsage) usage = normalizeUsage(candidateUsage);
            } catch {}
          }
          return remainder;
        };
        try {
          const streamBody = upstream.bridge === "chat_to_responses"
            ? chatStreamToResponsesStream(upstream.body, upstream.model || model.id)
            : upstream.body;
          for await (const chunk of streamBody) {
            bytes += chunk.length;
            streamText += streamDecoder.decode(chunk, { stream: true });
            streamText = readUsageEvents(streamText);
            res.write(chunk);
          }
          streamText += streamDecoder.decode();
          readUsageEvents(`${streamText}\n\n`);
          res.end();
          usageRecord({ success: true, endpoint: req.url, bytes, durationSeconds: elapsedSeconds(startedAt), ttftSeconds: elapsedSecondsBetween(startedAt, firstTokenAt), ...usage, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, ip });
        } catch (error) {
          usageRecord({ success: false, endpoint: req.url, bytes, durationSeconds: elapsedSeconds(startedAt), ttftSeconds: elapsedSecondsBetween(startedAt, firstTokenAt), ...usage, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, error: error.message, ip });
          if (!res.destroyed && !res.writableEnded) res.end();
        }
        return;
      }

      usageRecord({ success: true, endpoint: req.url, durationSeconds: elapsedSeconds(startedAt), ttftSeconds: null, ...normalizeUsage(upstream.body?.usage || upstream.body?.usageMetadata), model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, ip });
      return sendJson(res, upstream.status, upstream.body);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note
      });
      errors.push(detail);
      usageRecord({ success: false, endpoint: req.url, durationSeconds: elapsedSeconds(startedAt), ttftSeconds: null, model: alias, sourceModel: model.id, ...detail, error: error.message, ip });
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
  const ip = clientIp(req);
  if (!alias) return sendError(res, 400, "Missing model");
  const candidates = sortedCandidates(alias);
  if (!candidates.length) return sendError(res, 404, `No enabled channel found for proxy model: ${alias}`);

  const errors = [];
  for (const { channel, model } of candidates) {
    const startedAt = Date.now();
    try {
      const upstreamBody = replaceMultipartModel(rawBody, boundary, model.id);
      const upstream = await callImageEdits(channel, upstreamBody, req);
      usageRecord({ success: true, endpoint: req.url, durationSeconds: elapsedSeconds(startedAt), ttftSeconds: null, model: alias, sourceModel: model.id, channelId: channel.id, channelNote: channel.note, ip });
      return send(res, upstream.status, upstream.body, upstream.headers);
    } catch (error) {
      const detail = usageErrorDetail(error, {
        channelId: channel.id,
        channelNote: channel.note
      });
      errors.push(detail);
      usageRecord({ success: false, endpoint: req.url, durationSeconds: elapsedSeconds(startedAt), ttftSeconds: null, model: alias, sourceModel: model.id, ...detail, error: error.message, ip });
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
