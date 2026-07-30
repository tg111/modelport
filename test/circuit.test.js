const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = path.join(os.tmpdir(), `modelport-circuit-test-${process.pid}`);

const { state } = require("../src/state");
const {
  beginChannelAttempt,
  beginHealthCheck,
  publicCircuit,
  recordChannelFailure,
  recordChannelSuccess,
  resetChannelCircuit
} = require("../src/circuit");

state.db.settings = {
  textTimeoutSeconds: 120,
  imageTimeoutSeconds: 300,
  circuitFailureThreshold: 3,
  circuitCooldownSeconds: 60,
  authFailureCooldownSeconds: 900
};

function channel(id) {
  return { id, circuit: { status: "closed", consecutiveFailures: 0 } };
}

test("counted failures open a circuit at the configured threshold", () => {
  const item = channel("threshold");
  recordChannelFailure(item, Object.assign(new Error("bad gateway"), { upstreamStatus: 502 }));
  recordChannelFailure(item, Object.assign(new Error("rate limited"), { upstreamStatus: 429 }));
  assert.equal(publicCircuit(item).status, "closed");
  recordChannelFailure(item, Object.assign(new Error("network"), { name: "TypeError" }));
  assert.equal(publicCircuit(item).status, "open");
});

test("ordinary 4xx responses do not count as channel failures", () => {
  const item = channel("client-error");
  assert.equal(recordChannelFailure(item, Object.assign(new Error("bad request"), { upstreamStatus: 400 })), false);
  assert.equal(publicCircuit(item).consecutiveFailures, 0);
});

test("authentication failures open the circuit immediately", () => {
  const item = channel("auth");
  recordChannelFailure(item, Object.assign(new Error("unauthorized"), { upstreamStatus: 401 }));
  const circuit = publicCircuit(item);
  assert.equal(circuit.status, "open");
  assert.equal(circuit.reason.kind, "auth");
});

test("an expired circuit blocks real traffic and permits one health check", () => {
  const item = channel("half-open");
  item.circuit = {
    status: "open",
    consecutiveFailures: 3,
    retryAt: new Date(Date.now() - 1000).toISOString()
  };
  assert.equal(beginChannelAttempt(item), false);
  assert.equal(beginHealthCheck(item), true);
  assert.equal(beginHealthCheck(item), false);
  recordChannelSuccess(item);
  assert.equal(publicCircuit(item).status, "closed");
  resetChannelCircuit(item);
});
