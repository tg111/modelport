const { queueDbSave, state } = require("./state");

const halfOpenInFlight = new Set();

function settings() {
  return state.db.settings;
}

function circuitFor(channel) {
  if (!channel.circuit || typeof channel.circuit !== "object") {
    channel.circuit = { status: "closed", consecutiveFailures: 0 };
  }
  return channel.circuit;
}

function publicCircuit(channel) {
  const circuit = circuitFor(channel);
  return {
    status: halfOpenInFlight.has(channel.id) ? "half_open" : circuit.status,
    consecutiveFailures: Number(circuit.consecutiveFailures || 0),
    openedAt: circuit.openedAt || null,
    retryAt: circuit.retryAt || null,
    reason: circuit.reason || null
  };
}

function beginChannelAttempt(channel) {
  const circuit = circuitFor(channel);
  return circuit.status !== "open";
}

function beginHealthCheck(channel) {
  const circuit = circuitFor(channel);
  if (channel.enabled === false || circuit.status !== "open") return false;
  const retryAt = Date.parse(circuit.retryAt || "");
  if (!Number.isFinite(retryAt) || retryAt > Date.now() || halfOpenInFlight.has(channel.id)) return false;
  halfOpenInFlight.add(channel.id);
  return true;
}

function failureKind(error) {
  if (error?.isClientAbort) return null;
  const status = Number(error?.upstreamStatus);
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "server";
  if (status >= 400 && status <= 499) return null;
  if (error?.isTimeout || error?.name === "TimeoutError") return "timeout";
  return "network";
}

function openCircuit(channel, error, kind) {
  const circuit = circuitFor(channel);
  const config = settings();
  const baseCooldown = kind === "auth"
    ? config.authFailureCooldownSeconds * 1000
    : config.circuitCooldownSeconds * 1000;
  const cooldownMs = Math.max(baseCooldown, Number(error?.retryAfterMs || 0));
  const now = Date.now();
  circuit.status = "open";
  circuit.openedAt = new Date(now).toISOString();
  circuit.retryAt = new Date(now + cooldownMs).toISOString();
  circuit.reason = {
    kind,
    message: error?.message || "Upstream request failed",
    upstreamStatus: error?.upstreamStatus || null
  };
}

function recordChannelFailure(channel, error) {
  const circuit = circuitFor(channel);
  const wasHalfOpen = halfOpenInFlight.delete(channel.id);
  const kind = failureKind(error);
  if (!kind) return false;

  circuit.consecutiveFailures = Number(circuit.consecutiveFailures || 0) + 1;
  if (kind === "auth" || wasHalfOpen || circuit.consecutiveFailures >= settings().circuitFailureThreshold) {
    openCircuit(channel, error, kind);
  }
  queueDbSave();
  return true;
}

function recordChannelSuccess(channel) {
  const circuit = circuitFor(channel);
  const changed = circuit.status !== "closed" || Number(circuit.consecutiveFailures || 0) > 0 || halfOpenInFlight.has(channel.id);
  halfOpenInFlight.delete(channel.id);
  if (!changed) return;
  channel.circuit = { status: "closed", consecutiveFailures: 0 };
  queueDbSave();
}

function releaseChannelAttempt(channel) {
  halfOpenInFlight.delete(channel.id);
}

function deferHealthCheck(channel, error) {
  halfOpenInFlight.delete(channel.id);
  const circuit = circuitFor(channel);
  circuit.status = "open";
  circuit.retryAt = new Date(Date.now() + settings().circuitCooldownSeconds * 1000).toISOString();
  circuit.reason = {
    kind: "health_check",
    message: error?.message || "Health check failed",
    upstreamStatus: error?.upstreamStatus || null
  };
  queueDbSave();
}

function resetChannelCircuit(channel) {
  halfOpenInFlight.delete(channel.id);
  channel.circuit = { status: "closed", consecutiveFailures: 0 };
  channel.updatedAt = new Date().toISOString();
  queueDbSave();
}

module.exports = {
  beginChannelAttempt,
  beginHealthCheck,
  deferHealthCheck,
  publicCircuit,
  recordChannelFailure,
  recordChannelSuccess,
  releaseChannelAttempt,
  resetChannelCircuit
};
