const test = require("node:test");
const assert = require("node:assert/strict");

const { state } = require("../src/state");
const { publicChannel } = require("../src/channels");
const {
  CODEX_CALLBACK_URI,
  cancelCodexAuthorization,
  completeCodexAuthorization,
  defaultCodexModels,
  fetchCodexQuota,
  fetchCodexModels,
  finalizeCodexAuthorization,
  getCodexAuthorization,
  parseIdToken,
  startCodexAuthorization,
  storedOAuthInfo
} = require("../src/codex-oauth");
const { callImageGenerations, callResponses } = require("../src/providers");

function unsignedJwt(claims) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
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
    assert.deepEqual(JSON.parse(received.options.body), { input: "hello", model: "gpt-5.6-sol" });
  } finally {
    global.fetch = previousFetch;
    state.db.settings.textTimeoutSeconds = previousTimeout;
  }
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
    assert.equal(String(received.url), "https://chatgpt.com/backend-api/codex/models?client_version=0.153.3");
    assert.equal(received.options.headers.authorization, "Bearer access-secret");
    assert.equal(received.options.headers["chatgpt-account-id"], "account-123");
    assert.equal(received.options.headers.originator, "codex_cli_rs");
    assert.equal(received.options.headers.connection, "close");
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
    "gpt-6-astra",
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
