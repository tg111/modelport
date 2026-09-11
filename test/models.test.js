const test = require("node:test");
const assert = require("node:assert/strict");

const { state } = require("../src/state");
const { mergeModels, normalizeChannelPriority, sanitizeChannel, sortedCandidates } = require("../src/channels");

test("mergeModels uses the fetched model list as the source of truth", () => {
  const channel = {
    models: [
      { id: "still-available", alias: "custom-alias", enabled: false },
      { id: "removed-upstream", alias: "old-alias", enabled: true }
    ],
    testModelId: "removed-upstream",
    updatedAt: "2020-01-01T00:00:00.000Z"
  };

  mergeModels(channel, ["still-available", "new-model", "new-model", ""]);

  assert.deepEqual(channel.models, [
    { id: "still-available", alias: "custom-alias", enabled: false },
    { id: "new-model", alias: "new-model", enabled: true }
  ]);
  assert.equal(channel.testModelId, "");
  assert.notEqual(channel.updatedAt, "2020-01-01T00:00:00.000Z");
});

test("mergeModels keeps the selected test model when it is still available", () => {
  const channel = {
    models: [{ id: "available", alias: "available", enabled: true }],
    testModelId: "available"
  };

  mergeModels(channel, ["available"]);

  assert.equal(channel.testModelId, "available");
});

test("channel priority defaults to one and stays within its supported range", () => {
  assert.equal(normalizeChannelPriority(), 1);
  assert.equal(normalizeChannelPriority("4"), 4);
  assert.equal(normalizeChannelPriority(0), 1);
  assert.equal(normalizeChannelPriority(1001), 1000);
  assert.equal(sanitizeChannel({ apiBase: "https://example.com", apiKey: "key" }).priority, 1);
});

test("higher-priority channels are always selected before lower-priority fallbacks", () => {
  const previousChannels = state.db.channels;
  const previousRoundRobin = new Map(state.rr);
  const channel = (id, priority) => ({
    id,
    priority,
    enabled: true,
    models: [{ id: `${id}-model`, alias: "shared-model", enabled: true }]
  });
  state.db.channels = [
    channel("api-low", 1),
    channel("codex-high-a", 3),
    channel("api-high-b", 3)
  ];
  state.rr.clear();
  try {
    const first = sortedCandidates("shared-model").map(item => item.channel.id);
    const second = sortedCandidates("shared-model").map(item => item.channel.id);
    assert.deepEqual(first, ["codex-high-a", "api-high-b", "api-low"]);
    assert.deepEqual(second, ["api-high-b", "codex-high-a", "api-low"]);

    state.db.channels = [channel("codex-high", 5), channel("api-low", 1)];
    state.rr.clear();
    assert.equal(sortedCandidates("shared-model")[0].channel.id, "codex-high");
    assert.equal(sortedCandidates("shared-model")[0].channel.id, "codex-high");
  } finally {
    state.db.channels = previousChannels;
    state.rr.clear();
    for (const [key, value] of previousRoundRobin) state.rr.set(key, value);
  }
});
