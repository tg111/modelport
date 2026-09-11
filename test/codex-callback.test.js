const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { CODEX_CALLBACK_URI } = require("../src/codex-oauth");
const { createCodexCallbackHandler } = require("../src/codex-callback");

function request(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    }).on("error", reject);
  });
}

test("Codex callback listener completes the matching OAuth session", async () => {
  let received;
  const handler = createCodexCallbackHandler(async (sessionId, redirectUrl) => {
    received = { sessionId, redirectUrl };
    return { status: "completed" };
  });
  const server = http.createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await request(server, "/auth/callback?code=authorization-code&state=oauth-session");
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Codex 授权成功/);
    assert.equal(received.sessionId, "oauth-session");
    const callback = new URL(received.redirectUrl);
    assert.equal(callback.origin + callback.pathname, CODEX_CALLBACK_URI);
    assert.equal(callback.searchParams.get("code"), "authorization-code");
    assert.equal(callback.searchParams.get("state"), "oauth-session");
  } finally {
    server.close();
    await once(server, "close");
  }
});
