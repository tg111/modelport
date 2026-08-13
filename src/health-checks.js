const { beginHealthCheck, deferHealthCheck, recordChannelFailure, recordChannelSuccess } = require("./circuit");
const { testChannel } = require("./providers");
const { state } = require("./state");

const HEALTH_CHECK_MESSAGE = "你好";
const HEALTH_CHECK_INTERVAL_MS = 1000;

function enabledTestModel(channel) {
  if (!channel.testModelId) return null;
  return (channel.models || []).find(model => model.id === channel.testModelId && model.enabled === true) || null;
}

async function checkChannel(channel, model) {
  try {
    await testChannel(channel, HEALTH_CHECK_MESSAGE, model.id);
    recordChannelSuccess(channel);
  } catch (error) {
    const counted = recordChannelFailure(channel, error);
    if (!counted) deferHealthCheck(channel, error);
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
