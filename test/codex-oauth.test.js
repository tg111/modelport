const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = path.join(os.tmpdir(), `modelport-codex-oauth-test-${process.pid}`);

const { state } = require("../src/state");
const { publicChannel } = require("../src/channels");
const {
  CODEX_CALLBACK_URI,
  CODEX_CLIENT_VERSION,
  cancelCodexAuthorization,
  completeCodexAuthorization,
  defaultCodexModels,
  fetchCodexQuota,
  fetchCodexModels,
  finalizeCodexAuthorization,
  getCodexAuthorization,
  normalizeCodexResponseRequest,
  parseIdToken,
  startCodexAuthorization,
  storedOAuthInfo
} = require("../src/codex-oauth");
const { callImageGenerations, callResponses, testChannel } = require("../src/providers");
const { proxyResponses } = require("../src/proxy");

function unsignedJwt(claims) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
}

function responseCapture() {
  return {
    headersSent: false,
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = typeof body === "string" ? body : String(body || "");
    }
  };
}

test("Codex OAuth credentials are stored locally and public metadata excludes tokens", () => {
  const credentials = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
    email: "owner@example.com",
    accountId: "account-123",
    planType: "plus",
    subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z"
  };
  const stored = storedOAuthInfo(credentials, { lastRefreshAt: "2029-12-31T00:00:00.000Z" });
  stored.quota = {
    primary: { usedPercent: 20, windowMinutes: 300, resetAt: "2030-01-01T01:00:00.000Z" },
    secondary: { usedPercent: 40, windowMinutes: 10080, resetAt: "2030-01-08T00:00:00.000Z" },
    fetchedAt: "2030-01-01T00:00:00.000Z"
  };

  assert.deepEqual(stored.credentials, credentials);
  assert.equal(stored.email, "owner@example.com");

  const publicValue = publicChannel({
    id: "oauth-channel",
    authType: "codex_oauth",
    apiBase: "https://chatgpt.com/backend-api/codex",
    apiKey: "",
    enabled: true,
    models: [],
    codexOAuth: stored
  });
  const publicJson = JSON.stringify(publicValue);
  assert.equal(publicJson.includes("credentials"), false);
  assert.equal(publicJson.includes("access-secret"), false);
  assert.equal(publicValue.codexOAuth.email, "owner@example.com");
  assert.equal(publicValue.codexOAuth.subscriptionExpiresAt, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(publicValue.codexOAuth.quota, stored.quota);
});

test("Codex ID tokens expose account metadata without exposing the token", () => {
  const metadata = parseIdToken(unsignedJwt({
    email: "owner@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-123",
      chatgpt_plan_type: "plus",
      chatgpt_subscription_active_start: 1893369600,
      chatgpt_subscription_active_until: 1893456000
    }
  }));

  assert.deepEqual(metadata, {
    email: "owner@example.com",
    accountId: "account-123",
    planType: "plus",
    subscriptionActiveAt: "2029-12-31T00:00:00.000Z",
    subscriptionExpiresAt: "2030-01-01T00:00:00.000Z"
  });
});

test("Codex OAuth public metadata recovers subscription data from older stored tokens", () => {
  const idToken = unsignedJwt({
    email: "owner@example.com",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "team",
      chatgpt_subscription_active_start: 1893369600,
      chatgpt_subscription_active_until: 1893456000
    }
  });
  const publicValue = publicChannel({
    id: "legacy-oauth-channel",
    authType: "codex_oauth",
    apiBase: "https://chatgpt.com/backend-api/codex",
    apiKey: "",
    enabled: true,
    models: [],
    codexOAuth: {
      credentials: {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        idToken
      }
    }
  });

  assert.equal(publicValue.codexOAuth.planType, "team");
  assert.equal(publicValue.codexOAuth.subscriptionExpiresAt, "2030-01-01T00:00:00.000Z");
  assert.equal(JSON.stringify(publicValue).includes(idToken), false);
});

test("Codex OAuth creates a CPA-compatible PKCE authorization link", () => {
  const session = startCodexAuthorization({ note: "Test Codex" });
  const url = new URL(session.authorizationUrl);

  assert.equal(session.status, "pending");
  assert.equal(session.callbackUri, CODEX_CALLBACK_URI);
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), CODEX_CALLBACK_URI);
  assert.equal(url.searchParams.get("state"), session.id);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile offline_access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(cancelCodexAuthorization(session.id), true);
});

test("Codex OAuth completes after a matching callback URL is pasted", async () => {
  const session = startCodexAuthorization();
  const previousFetch = global.fetch;
  let received;
  const idToken = unsignedJwt({
    email: "owner@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "account-123", chatgpt_plan_type: "plus" }
  });
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      id_token: idToken,
      expires_in: 3600
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const callback = `${CODEX_CALLBACK_URI}?code=authorization-code&state=${encodeURIComponent(session.id)}`;
    await completeCodexAuthorization(session.id, callback);
    assert.equal(received.url, "https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(received.options.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "authorization-code");
    assert.equal(body.get("redirect_uri"), CODEX_CALLBACK_URI);
    assert.equal(body.get("code_verifier"), getCodexAuthorization(session.id).codeVerifier);
    assert.equal(getCodexAuthorization(session.id).status, "completed");
    assert.equal(finalizeCodexAuthorization(session.id, "oauth-channel").accessToken, "access-secret");
  } finally {
    global.fetch = previousFetch;
  }
});

test("Codex OAuth Responses requests use the stored token and account header", async () => {
  const credentials = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "",
    email: "owner@example.com",
    accountId: "account-123",
    planType: "plus",
    expiresAt: "2030-01-01T00:00:00.000Z"
  };
  const channel = {
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo(credentials),
    protocol: "responses"
  };
  const previousFetch = global.fetch;
  const previousTimeout = state.db.settings.textTimeoutSeconds;
  let received;
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({ id: "response_1", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  state.db.settings.textTimeoutSeconds = 10;
  try {
    const result = await callResponses(channel, "gpt-5.6-sol", { input: "hello" });
    assert.equal(result.body.id, "response_1");
    assert.equal(received.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(received.options.headers.authorization, "Bearer access-secret");
    assert.equal(received.options.headers["chatgpt-account-id"], "account-123");
    assert.deepEqual(JSON.parse(received.options.body), {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }],
      model: "gpt-5.6-sol",
      store: false,
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"]
    });
  } finally {
    global.fetch = previousFetch;
    state.db.settings.textTimeoutSeconds = previousTimeout;
  }
});

test("Codex OAuth channel tests request and collect a streaming Response", async () => {
  const channel = {
    enabled: true,
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "",
      expiresAt: "2030-01-01T00:00:00.000Z"
    }),
    models: [{ id: "gpt-5.6-sol", alias: "codex-test", enabled: true }]
  };
  const previousFetch = global.fetch;
  const previousTimeout = state.db.settings.textTimeoutSeconds;
  let received;
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response([
      "event: response.output_text.delta\n",
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      "event: response.output_text.done\n",
      'data: {"type":"response.output_text.done","text":"hello"}\n\n',
      "event: response.completed\n",
      'data: {"type":"response.completed","response":{"id":"response_1","usage":{"input_tokens":3,"output_tokens":1}}}\n\n'
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  state.db.settings.textTimeoutSeconds = 10;
  try {
    const result = await testChannel(channel, "hello");
    assert.equal(received.url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(received.options.headers.accept, "text/event-stream");
    assert.deepEqual(JSON.parse(received.options.body), {
      model: "gpt-5.6-sol",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }],
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"]
    });
    assert.equal(result.upstream.stream, false);
    assert.equal(result.upstream.body.output_text, "hello");
    assert.deepEqual(result.upstream.body.usage, { input_tokens: 3, output_tokens: 1 });
  } finally {
    global.fetch = previousFetch;
    state.db.settings.textTimeoutSeconds = previousTimeout;
  }
});

test("Codex OAuth applies CPA-compatible Responses normalization", () => {
  const request = {
    model: "gpt-5.6-sol",
    max_output_tokens: 1000,
    max_completion_tokens: 1000,
    temperature: 0.2,
    top_p: 0.9,
    truncation: "auto",
    prompt_cache_options: { mode: "implicit" },
    prompt_cache_retention: "24h",
    context_management: { type: "compaction" },
    user: "openclaw-user",
    service_tier: "standard",
    store: true,
    parallel_tool_calls: false,
    include: ["web_search_call.action.sources"],
    input: [
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "OpenClaw instructions", prompt_cache_breakpoint: { mode: "explicit" } }]
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Existing developer message" }] },
      { type: "function_call", name: "lookup", arguments: "{}" }
    ],
    tools: [{ type: "web_search_preview" }],
    tool_choice: { type: "web_search_preview_2025_03_11", tools: [{ type: "web_search_preview" }] }
  };

  const normalized = normalizeCodexResponseRequest(request);

  assert.equal(normalized.input[0].role, "developer");
  assert.equal(normalized.input[1].role, "user");
  assert.equal(normalized.input[2].role, "developer");
  assert.equal(normalized.input[3].type, "function_call");
  assert.equal(Object.hasOwn(normalized.input[0].content[0], "prompt_cache_breakpoint"), false);
  assert.equal(Object.hasOwn(normalized, "max_output_tokens"), false);
  assert.equal(Object.hasOwn(normalized, "max_completion_tokens"), false);
  assert.equal(Object.hasOwn(normalized, "temperature"), false);
  assert.equal(Object.hasOwn(normalized, "top_p"), false);
  assert.equal(Object.hasOwn(normalized, "truncation"), false);
  assert.equal(Object.hasOwn(normalized, "prompt_cache_options"), false);
  assert.equal(Object.hasOwn(normalized, "prompt_cache_retention"), false);
  assert.equal(Object.hasOwn(normalized, "context_management"), false);
  assert.equal(Object.hasOwn(normalized, "user"), false);
  assert.equal(Object.hasOwn(normalized, "service_tier"), false);
  assert.equal(normalized.store, false);
  assert.equal(normalized.parallel_tool_calls, true);
  assert.deepEqual(normalized.include, ["reasoning.encrypted_content"]);
  assert.equal(normalized.tools[0].type, "web_search");
  assert.equal(normalized.tool_choice.type, "web_search");
  assert.equal(normalized.tool_choice.tools[0].type, "web_search");
  assert.equal(request.input[0].role, "system");
  assert.equal(request.max_output_tokens, 1000);
});

test("Codex OAuth converts string input to a standard user message", () => {
  const normalized = normalizeCodexResponseRequest({ model: "gpt-5.6-sol", input: "Hello" });
  assert.deepEqual(normalized.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Hello" }]
  }]);
});

test("Codex OAuth fetches the account models and adds CPA's built-in image models", async () => {
  const channel = {
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "",
      email: "owner@example.com",
      accountId: "account-123",
      planType: "plus",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })
  };
  const previousFetch = global.fetch;
  let received;
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({
      models: [
        { slug: "gpt-6-astra" },
        { slug: "gpt-5.6-sol" },
        { slug: "gpt-6-astra" },
        { id: "codex-auto-review" }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await fetchCodexModels(channel), [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "codex-auto-review",
      "gpt-image-1.5",
      "gpt-image-2",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
      "gpt-image-2.5"
    ]);
    assert.equal(String(received.url), `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
    assert.equal(received.options.headers.authorization, "Bearer access-secret");
    assert.equal(received.options.headers["chatgpt-account-id"], "account-123");
    assert.equal(received.options.headers.originator, "codex_cli_rs");
    assert.equal(received.options.headers.connection, "close");
    assert.match(received.options.headers["user-agent"], new RegExp(`^codex_cli_rs/${CODEX_CLIENT_VERSION.replaceAll(".", "\\.")}`));
  } finally {
    global.fetch = previousFetch;
  }
});

test("Codex OAuth model fetch reports the underlying network failure", async () => {
  const channel = {
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "",
      email: "owner@example.com",
      accountId: "account-123",
      planType: "plus",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })
  };
  const previousFetch = global.fetch;
  global.fetch = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
    throw error;
  };
  try {
    await assert.rejects(fetchCodexModels(channel), /UND_ERR_CONNECT_TIMEOUT/);
  } finally {
    global.fetch = previousFetch;
  }
});

test("Codex OAuth usage-limit errors retain their reset time", async () => {
  const channel = {
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "",
      email: "owner@example.com",
      accountId: "account-123",
      planType: "team",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })
  };
  const previousFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      plan_type: "team",
      resets_at: 1893456000
    }
  }), { status: 429, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      callResponses(channel, "gpt-5.6-sol", { input: "hello" }),
      error => error.codexUsageLimit?.resetAt === "2030-01-01T00:00:00.000Z"
        && error.codexUsageLimit?.planType === "team"
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test("Codex OAuth usage exhaustion skips the channel until its reset time", async () => {
  const previousChannels = state.db.channels;
  const previousUsage = state.db.usage;
  const previousFetch = global.fetch;
  const previousRoundRobin = new Map(state.rr);
  const credentials = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "",
    email: "owner@example.com",
    accountId: "account-123",
    planType: "team",
    expiresAt: "2030-01-01T00:00:00.000Z"
  };
  const oauthChannel = {
    id: "oauth-high",
    authType: "codex_oauth",
    enabled: true,
    priority: 2,
    note: "OAuth high",
    models: [{ id: "gpt-5.6-sol", alias: "shared-model", enabled: true }],
    codexOAuth: storedOAuthInfo(credentials),
    circuit: { status: "closed", consecutiveFailures: 0 }
  };
  const apiChannel = {
    id: "api-low",
    enabled: true,
    priority: 1,
    note: "API low",
    apiBase: "https://api.example.test",
    apiKey: "api-secret",
    protocol: "responses",
    models: [{ id: "fallback-model", alias: "shared-model", enabled: true }],
    circuit: { status: "closed", consecutiveFailures: 0 }
  };
  let oauthCalls = 0;
  let apiCalls = 0;
  global.fetch = async url => {
    if (String(url).startsWith("https://chatgpt.com/backend-api/codex/responses")) {
      oauthCalls += 1;
      if (oauthCalls === 1) {
        return new Response(JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            plan_type: "team",
            resets_at: Math.floor(Date.now() / 1000) + 3600
          }
        }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "oauth-response", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://api.example.test/v1/responses")) {
      apiCalls += 1;
      return new Response(JSON.stringify({ id: `api-response-${apiCalls}`, output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  state.db.channels = [oauthChannel, apiChannel];
  state.db.usage = [];
  state.rr.clear();
  try {
    const first = responseCapture();
    await proxyResponses({ url: "/v1/responses", headers: {} }, first, { model: "shared-model", input: "first" });
    assert.equal(first.status, 200);
    assert.equal(oauthCalls, 1);
    assert.equal(apiCalls, 1);
    assert.equal(oauthChannel.circuit.status, "closed");
    assert.ok(oauthChannel.codexOAuth.usageLimit?.resetAt);

    apiChannel.enabled = false;
    const onlyPaused = responseCapture();
    await proxyResponses({ url: "/v1/responses", headers: {} }, onlyPaused, { model: "shared-model", input: "paused" });
    const pausedError = JSON.parse(onlyPaused.body).error;
    assert.equal(onlyPaused.status, 429);
    assert.equal(pausedError.type, "usage_limit_reached");
    assert.equal(pausedError.resets_at, Math.floor(Date.parse(oauthChannel.codexOAuth.usageLimit.resetAt) / 1000));

    apiChannel.enabled = true;
    const whilePaused = responseCapture();
    await proxyResponses({ url: "/v1/responses", headers: {} }, whilePaused, { model: "shared-model", input: "second" });
    assert.equal(whilePaused.status, 200);
    assert.equal(oauthCalls, 1);
    assert.equal(apiCalls, 2);

    oauthChannel.codexOAuth.usageLimit.resetAt = new Date(Date.now() - 1000).toISOString();
    const afterReset = responseCapture();
    await proxyResponses({ url: "/v1/responses", headers: {} }, afterReset, { model: "shared-model", input: "third" });
    assert.equal(afterReset.status, 200);
    assert.equal(oauthCalls, 2);
    assert.equal(apiCalls, 2);
    assert.equal(oauthChannel.codexOAuth.usageLimit, undefined);
  } finally {
    state.db.channels = previousChannels;
    state.db.usage = previousUsage;
    state.rr.clear();
    for (const [key, value] of previousRoundRobin) state.rr.set(key, value);
    global.fetch = previousFetch;
  }
});

test("Codex OAuth fetches and normalizes the 5-hour and weekly quota windows", async () => {
  const channel = {
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken: "",
      email: "owner@example.com",
      accountId: "account-123",
      planType: "plus",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })
  };
  const previousFetch = global.fetch;
  let received;
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({
      plan_type: "pro",
      rate_limits: {
        primary: { used_percent: 31.5, window_minutes: 300, reset_at: 1893456000 },
        secondary: { used_percent: 72, limit_window_seconds: 604800, reset_at: 1894060800 }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const quota = await fetchCodexQuota(channel);
    assert.deepEqual(quota, {
      primary: { usedPercent: 31.5, windowMinutes: 300, resetAt: "2030-01-01T00:00:00.000Z" },
      secondary: { usedPercent: 72, windowMinutes: 10080, resetAt: "2030-01-08T00:00:00.000Z" },
      planType: "pro",
      fetchedAt: quota.fetchedAt
    });
    assert.match(quota.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(received.url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(received.options.headers.authorization, "Bearer access-secret");
    assert.equal(received.options.headers["chatgpt-account-id"], "account-123");
    assert.equal(received.options.headers.originator, "codex_cli_rs");
  } finally {
    global.fetch = previousFetch;
  }
});

test("Codex OAuth starts with editable default Codex models", () => {
  assert.deepEqual(defaultCodexModels().map(model => model.id), [
    "gpt-6-sol",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "codex-auto-review",
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5"
  ]);
});

test("Codex OAuth sends built-in image models to CPA's direct image endpoint", async () => {
  const credentials = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "",
    email: "owner@example.com",
    accountId: "account-123",
    planType: "plus",
    expiresAt: "2030-01-01T00:00:00.000Z"
  };
  const channel = {
    authType: "codex_oauth",
    codexOAuth: storedOAuthInfo(credentials)
  };
  const previousFetch = global.fetch;
  const previousTimeout = state.db.settings.imageTimeoutSeconds;
  let received;
  global.fetch = async (url, options) => {
    received = { url, options };
    return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "image-data" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  state.db.settings.imageTimeoutSeconds = 10;
  try {
    const result = await callImageGenerations(channel, "gpt-image-2.5", { prompt: "a cat" });
    assert.deepEqual(result.body, { created: 1, data: [{ b64_json: "image-data" }] });
    assert.equal(received.url, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(received.options.headers.authorization, "Bearer access-secret");
    assert.equal(received.options.headers["chatgpt-account-id"], "account-123");
    assert.deepEqual(JSON.parse(received.options.body), { prompt: "a cat", model: "gpt-image-2.5" });
  } finally {
    global.fetch = previousFetch;
    state.db.settings.imageTimeoutSeconds = previousTimeout;
  }
});
