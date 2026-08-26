const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeUsage, estimateInputUsage } = require("../src/utils");

test("normalizes OpenAI usage and preserves cache/reasoning breakdown", () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 40,
    total_tokens: 140,
    prompt_tokens_details: { cached_tokens: 20, cache_creation_tokens: 4, cache_write_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 10 }
  }), {
    inputTokens: 100,
    outputTokens: 40,
    cachedTokens: 20,
    cacheReadTokens: 20,
    cacheCreationTokens: 4,
    cacheWriteTokens: 2,
    reasoningTokens: 10,
    totalTokens: 140,
    usageSource: "upstream",
    usageQuality: "reported"
  });
});

test("accepts CPA canonical cache token field names", () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    cache_read_tokens: 25,
    cache_creation_tokens: 5
  }), {
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 25,
    cacheReadTokens: 25,
    cacheCreationTokens: 5,
    totalTokens: 110,
    usageSource: "upstream",
    usageQuality: "reported"
  });
});

test("derives a missing or zero total from input and output", () => {
  for (const total of [undefined, 0]) {
    const usage = normalizeUsage({ input_tokens: 7, output_tokens: 3, total_tokens: total });
    assert.equal(usage.totalTokens, 10);
    assert.equal(usage.totalTokensDerived, true);
    assert.equal(usage.usageQuality, "derived");
  }
});

test("marks contradictory reported totals without hiding the upstream value", () => {
  const usage = normalizeUsage({ input_tokens: 7, output_tokens: 3, total_tokens: 99 });
  assert.equal(usage.totalTokens, 99);
  assert.equal(usage.usageQuality, "inconsistent");
});

test("adds Gemini tool-use prompt tokens to input tokens", () => {
  const usage = normalizeUsage({ promptTokenCount: 12, toolUsePromptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 20 });
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.totalTokens, 20);
});

test("estimates only input tokens when upstream usage is absent", () => {
  const usage = estimateInputUsage({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] }, "gpt-4o");
  assert.equal(usage.outputTokens, undefined);
  assert.equal(usage.usageSource, "estimated");
  assert.ok(usage.inputTokens > 0);
  assert.equal(usage.totalTokens, usage.inputTokens);
});

test("includes Responses function calls and tool outputs in estimates", () => {
  const plain = estimateInputUsage({ input: "hello" }, "gpt-4o");
  const withTools = estimateInputUsage({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", name: "lookup", arguments: "{\"id\":123}" },
      { type: "function_call_output", output: "result" }
    ]
  }, "gpt-4o");
  assert.ok(withTools.inputTokens > plain.inputTokens);
});
