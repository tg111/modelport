const test = require("node:test");
const assert = require("node:assert/strict");

const { state } = require("../src/state");
const { outboundDispatcher } = require("../src/outbound-proxy");

test("outbound proxy creates an undici dispatcher for the configured HTTP proxy", () => {
  const previousSettings = state.db.settings;
  state.db.settings = { outboundProxyEnabled: true, outboundProxyUrl: "http://127.0.0.1:7890" };
  try {
    assert.equal(typeof outboundDispatcher().dispatch, "function");
  } finally {
    state.db.settings = previousSettings;
  }
});
