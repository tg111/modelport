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

test("Codex client version defaults, trims and rejects invalid versions", () => {
  assert.equal(validateSettings({}).codexClientVersion, "0.160.0");
  assert.equal(validateSettings({ codexClientVersion: " 0.161.0 " }).codexClientVersion, "0.161.0");
  for (const version of ["", "latest", "0.160", "0.160.0\r\nInjected: true", 160]) {
    assert.throws(() => validateSettings({ codexClientVersion: version }), /codexClientVersion/);
    assert.equal(normalizeSettings({ codexClientVersion: version }).codexClientVersion, "0.160.0");
  }
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
