const { beginHealthCheck, deferHealthCheck, recordChannelFailure, recordChannelSuccess } = require("./circuit");
const { testChannel } = require("./providers");
const { state, usageRecord } = require("./state");
const { normalizeUsage, usageErrorDetail } = require("./utils");

const HEALTH_CHECK_MESSAGE = "你好";
const HEALTH_CHECK_INTERVAL_MS = 1000;

function enabledTestModel(channel) {
  if (!channel.testModelId) return null;
  return (channel.models || []).find(model => model.id === channel.testModelId && model.enabled === true) || null;
}

function elapsedSeconds(startedAt) {
  return Number(((Date.now() - startedAt) / 1000).toFixed(1));
}

async function checkChannel(channel, model) {
  const startedAt = Date.now();
  try {
    const result = await testChannel(channel, HEALTH_CHECK_MESSAGE, model.id);
    recordChannelSuccess(channel);
    usageRecord({
      success: true,
      endpoint: "health-check",
      model: model.alias || model.id,
      sourceModel: model.id,
      channelId: channel.id,
      channelNote: channel.note,
      request: HEALTH_CHECK_MESSAGE,
      durationSeconds: elapsedSeconds(startedAt),
      ttftSeconds: null,
      ...normalizeUsage(result.upstream.body?.usage || result.upstream.body?.usageMetadata)
    });
  } catch (error) {
    const counted = recordChannelFailure(channel, error);
    if (!counted) deferHealthCheck(channel, error);
    usageRecord({
      success: false,
      endpoint: "health-check",
      model: model.alias || model.id,
      sourceModel: model.id,
      channelId: channel.id,
      channelNote: channel.note,
      request: HEALTH_CHECK_MESSAGE,
      durationSeconds: elapsedSeconds(startedAt),
      ttftSeconds: null,
      ...usageErrorDetail(error),
      error: error.message
    });
  }
}

async function runHealthChecks() {
  const checks = [];
  for (const channel of state.db.channels) {
    if (channel.enabled === false) continue;
    const model = enabledTestModel(channel);
    if (!model || !beginHealthCheck(channel)) continue;
    checks.push(checkChannel(channel, model));
  }
  await Promise.allSettled(checks);
  return checks.length;
}

function startHealthChecks() {
  const timer = setInterval(() => {
    runHealthChecks().catch(error => console.warn(`Health check error: ${error.message}`));
  }, HEALTH_CHECK_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

module.exports = {
  enabledTestModel,
  runHealthChecks,
  startHealthChecks
};
