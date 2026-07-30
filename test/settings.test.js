const test = require("node:test");
const assert = require("node:assert/strict");

const { DEFAULT_SETTINGS, normalizeSettings, validateSettings } = require("../src/settings");

test("normalizeSettings supplies defaults for old databases", () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ textTimeoutSeconds: 45 }).textTimeoutSeconds, 45);
});

test("validateSettings rejects values outside their ranges", () => {
  assert.throws(
    () => validateSettings({ ...DEFAULT_SETTINGS, circuitFailureThreshold: 0 }),
    /circuitFailureThreshold/
  );
});
