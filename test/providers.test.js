const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");

const { state } = require("../src/state");
const { callChatCompletions } = require("../src/providers");

async function upstream(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test("non-streaming text requests use the configured timeout", async () => {
  state.db.settings.textTimeoutSeconds = 0.05;
  const mock = await upstream((req, res) => {
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end("{}");
    }, 100);
  });
  try {
    await assert.rejects(
      callChatCompletions({ apiBase: mock.apiBase, apiKey: "test" }, "model", { stream: false }),
      error => error.isTimeout === true
    );
  } finally {
    await mock.close();
  }
});

test("streaming timeout is cancelled after the first token", async () => {
  state.db.settings.textTimeoutSeconds = 0.08;
  const mock = await upstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'), 20);
    setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"B"}}]}\n\n'), 140);
  });
  try {
    const response = await callChatCompletions({ apiBase: mock.apiBase, apiKey: "test" }, "model", { stream: true });
    const iterator = response.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    response.cancelTimeout();
    let bytes = first.value.length;
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) bytes += chunk.length;
    assert.ok(bytes > first.value.length);
  } finally {
    await mock.close();
  }
});
