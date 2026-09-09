const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeModels } = require("../src/channels");

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
