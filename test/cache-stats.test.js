const test = require("node:test");
const assert = require("node:assert/strict");

const { calculateCacheStats } = require("../src/channels");

test("calculates a channel cache read rate", () => {
  assert.deepEqual(calculateCacheStats([
    { inputTokens: 100, cacheReadTokens: 25, usageSource: "upstream" }
  ]), {
    inputTokens: 100,
    cacheReadTokens: 25,
    cacheCreationTokens: 0,
    calculableCount: 1,
    cacheReadRate: 25
  });
});

test("uses token-weighted totals instead of averaging request rates", () => {
  const stats = calculateCacheStats([
    { inputTokens: 100, cacheReadTokens: 25, usageSource: "upstream" },
    { inputTokens: 300, cacheReadTokens: 150, cacheCreationTokens: 12, usageSource: "upstream" }
  ]);
  assert.equal(stats.inputTokens, 400);
  assert.equal(stats.cacheReadTokens, 175);
  assert.equal(stats.cacheCreationTokens, 12);
  assert.equal(stats.calculableCount, 2);
  assert.equal(stats.cacheReadRate, 43.75);
});

test("returns null when there are no valid upstream input tokens", () => {
  const stats = calculateCacheStats([
    { inputTokens: 100, cacheReadTokens: 50, usageSource: "estimated" },
    { inputTokens: 0, cacheReadTokens: 0, usageSource: "upstream" }
  ]);
  assert.equal(stats.cacheReadRate, null);
  assert.equal(stats.calculableCount, 0);
});

test("supports legacy cachedTokens and treats missing cache details as zero", () => {
  const stats = calculateCacheStats([
    { inputTokens: 100, cachedTokens: 20, usageSource: "upstream" },
    { inputTokens: 100, usageSource: "upstream" }
  ]);
  assert.equal(stats.cacheReadTokens, 20);
  assert.equal(stats.inputTokens, 200);
  assert.equal(stats.cacheReadRate, 10);
});
