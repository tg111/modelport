const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_SETTINGS, normalizeSettings, validateSettings } = require("../src/settings");

test("normalizeSettings supplies defaults for old databases", () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ textTimeoutSeconds: 45 }).textTimeoutSeconds, 45);
  assert.equal(normalizeSettings({ outboundProxyEnabled: true }).outboundProxyEnabled, false);
});

test("validateSettings rejects values outside their ranges", () => {
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, circuitFailureThreshold: 0 }),
    /circuitFailureThreshold/
  );
});

test("validateSettings accepts an HTTP outbound proxy and requires its URL when enabled", () => {
  const settings = validateSettings({
    ...DEFAULT_SETTINGS,
    outboundProxyEnabled: true,
    outboundProxyUrl: "http://127.0.0.1:7890"
  });
  assert.equal(settings.outboundProxyEnabled, true);
  assert.equal(settings.outboundProxyUrl, "http://127.0.0.1:7890/");
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, outboundProxyEnabled: true }),
    /outboundProxyUrl is required/
  );
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, outboundProxyUrl: "socks5://127.0.0.1:7890" }),
    /outboundProxyUrl/
  );
});
