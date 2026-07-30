const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = path.join(os.tmpdir(), `modelport-health-check-test-${process.pid}`);

const { state } = require("../src/state");
const { runHealthChecks } = require("../src/health-checks");

state.db.settings = {
  textTimeoutSeconds: 2,
  imageTimeoutSeconds: 2,
  circuitFailureThreshold: 3,
  circuitCooldownSeconds: 60,
  authFailureCooldownSeconds: 900
};

async function upstream(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function openChannel(id, apiBase, overrides = {}) {
  return {
    id,
    apiBase,
    apiKey: "test",
    protocol: "responses",
    note: id,
    enabled: true,
    testModelId: "text-model",
    models: [{ id: "text-model", alias: "proxy-text", enabled: true }],
    circuit: {
      status: "open",
      consecutiveFailures: 3,
      retryAt: new Date(Date.now() - 1000).toISOString()
    },
    ...overrides
  };
}

test("active health checks use the enabled test model and hello message", async () => {
  let receivedBody = null;
  const mock = await upstream((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      receivedBody = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ output: [{ content: [{ text: "ok" }] }] }));
    });
  });
  try {
    const channel = openChannel("active", mock.apiBase);
    state.db.channels = [channel];
    assert.equal(await runHealthChecks(), 1);
    assert.deepEqual(receivedBody, { model: "text-model", input: "你好" });
    assert.equal(channel.circuit.status, "closed");
  } finally {
    await mock.close();
  }
});

test("disabled channels and channels without an enabled test model are not checked", async () => {
  let requestCount = 0;
  const mock = await upstream((req, res) => {
    requestCount += 1;
    res.end("{}");
  });
  try {
    state.db.channels = [
      openChannel("disabled", mock.apiBase, { enabled: false }),
      openChannel("no-test-model", mock.apiBase, { testModelId: "" }),
      openChannel("disabled-test-model", mock.apiBase, {
        models: [{ id: "text-model", alias: "proxy-text", enabled: false }]
      })
    ];
    assert.equal(await runHealthChecks(), 0);
    assert.equal(requestCount, 0);
  } finally {
    await mock.close();
  }
});
