/*
 * Portions adapted from CLIProxyAPI's Codex OAuth implementation.
 * See THIRD_PARTY_NOTICES.md for copyright and license information.
 */

const crypto = require("crypto");
const { queueDbSave } = require("./state");
const { outboundFetch } = require("./outbound-proxy");

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CALLBACK_URI = "http://localhost:1455/auth/callback";
const CODEX_UPSTREAM_BASE = "https://chatgpt.com/backend-api/codex";
const CODEX_QUOTA_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CLIENT_VERSION = "0.153.3";
const CODEX_AUTHORIZATION_TIMEOUT_MS = 15 * 60 * 1000;
const CODEX_REFRESH_LEAD_MS = 5 * 60 * 1000;

// These are the Codex model IDs exposed by the CPA reference implementation.
// Availability still depends on the connected account and can be edited per channel.
// CPA registers the image models locally because the Codex /models endpoint does
// not currently include them.
const CODEX_IMAGE_MODELS = [
  "gpt-image-1.5",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5"
];

const DEFAULT_CODEX_MODELS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "codex-auto-review",
  ...CODEX_IMAGE_MODELS
];

const authorizationSessions = new Map();
const refreshInFlight = new Map();

function oauthError(message, options = {}) {
  return Object.assign(new Error(message), options);
}

function parseIdToken(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return {};
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const auth = claims["https://api.openai.com/auth"] || {};
    return {
      email: typeof claims.email === "string" ? claims.email : "",
      accountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : "",
      planType: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : "",
      subscriptionExpiresAt: timestampToIso(auth.chatgpt_subscription_active_until),
      subscriptionActiveAt: timestampToIso(auth.chatgpt_subscription_active_start)
    };
  } catch {
    return {};
  }
}

function timestampToIso(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const milliseconds = number >= 100000000000 ? number : number * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tokenCredentials(response, previous = {}) {
  const claims = parseIdToken(response.id_token || previous.idToken);
  const expiresIn = Number(response.expires_in);
  return {
    accessToken: String(response.access_token || ""),
    refreshToken: String(response.refresh_token || previous.refreshToken || ""),
    idToken: String(response.id_token || previous.idToken || ""),
    email: claims.email || previous.email || "",
    accountId: claims.accountId || previous.accountId || "",
    planType: claims.planType || previous.planType || "",
    subscriptionExpiresAt: claims.subscriptionExpiresAt || previous.subscriptionExpiresAt || null,
    subscriptionActiveAt: claims.subscriptionActiveAt || previous.subscriptionActiveAt || null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : previous.expiresAt || null
  };
}

function publicOAuthInfo(credentials, options = {}) {
  const tokenClaims = parseIdToken(credentials.idToken);
  return {
    email: credentials.email || tokenClaims.email || "",
    planType: credentials.planType || tokenClaims.planType || "",
    subscriptionExpiresAt: credentials.subscriptionExpiresAt || tokenClaims.subscriptionExpiresAt || null,
    subscriptionActiveAt: credentials.subscriptionActiveAt || tokenClaims.subscriptionActiveAt || null,
    expiresAt: credentials.expiresAt || null,
    lastRefreshAt: options.lastRefreshAt || new Date().toISOString(),
    status: options.status || "active"
  };
}

function storedOAuthInfo(credentials, options = {}) {
  return {
    ...publicOAuthInfo(credentials, options),
    credentials: { ...credentials }
  };
}

function isCodexOAuthChannel(channel) {
  const credentials = channel?.codexOAuth?.credentials;
  return channel?.authType === "codex_oauth" && Boolean(credentials?.accessToken && credentials?.refreshToken);
}

function defaultCodexModels() {
  return DEFAULT_CODEX_MODELS.map(id => ({ id, alias: id, enabled: true }));
}

function isCodexImageModel(modelId) {
  return CODEX_IMAGE_MODELS.includes(String(modelId || "").trim().toLowerCase());
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await outboundFetch(url, options);
  } catch (error) {
    throw oauthError(`Codex OAuth request failed: ${error.message}`, { upstreamStatus: null });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body?.error_description || body?.error?.message || body?.error || "").trim();
    throw oauthError(`Codex OAuth request failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`, {
      upstreamStatus: response.status
    });
  }
  return body;
}

function sessionPublic(session) {
  return {
    id: session.id,
    status: session.status,
    authorizationUrl: session.authorizationUrl,
    callbackUri: CODEX_CALLBACK_URI,
    expiresAt: session.expiresAt,
    error: session.error || null,
    channelId: session.channelId || null,
    targetChannelId: session.targetChannelId || null
  };
}

function newPkceCodes() {
  const codeVerifier = crypto.randomBytes(96).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function authorizationUrl(state, codeChallenge) {
  const url = new URL(CODEX_AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: "code",
    redirect_uri: CODEX_CALLBACK_URI,
    scope: "openid email profile offline_access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true"
  }).toString();
  return url.toString();
}

async function exchangeAuthorizationCode(authorizationCode, codeVerifier) {
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code: authorizationCode,
    redirect_uri: CODEX_CALLBACK_URI,
    code_verifier: codeVerifier
  });
  const token = await requestJson(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: payload,
    signal: AbortSignal.timeout(30000)
  });
  const credentials = tokenCredentials(token);
  if (!credentials.accessToken || !credentials.refreshToken || !credentials.email) {
    throw oauthError("Codex OAuth token exchange returned incomplete account information");
  }
  return credentials;
}

function callbackUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw oauthError("Please paste the complete Codex callback URL", { statusCode: 400 });
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "http:" || !localHost || url.port !== "1455" || url.pathname !== "/auth/callback") {
    throw oauthError("The callback URL must use http://localhost:1455/auth/callback", { statusCode: 400 });
  }
  return url;
}

function startCodexAuthorization(options = {}) {
  const id = crypto.randomBytes(32).toString("base64url");
  const { codeVerifier, codeChallenge } = newPkceCodes();
  const session = {
    id,
    status: "pending",
    authorizationUrl: authorizationUrl(id, codeChallenge),
    codeVerifier,
    expiresAt: new Date(Date.now() + CODEX_AUTHORIZATION_TIMEOUT_MS).toISOString(),
    channelId: null,
    targetChannelId: String(options.targetChannelId || "").trim() || null,
    note: String(options.note || "").trim(),
    error: null,
    credentials: null
  };
  authorizationSessions.set(session.id, session);
  return sessionPublic(session);
}

function getCodexAuthorization(id) {
  const session = authorizationSessions.get(String(id || ""));
  if (!session) return null;
  if (session.status === "pending" && Date.now() >= Date.parse(session.expiresAt)) {
    session.status = "expired";
    session.error = "Codex authorization timed out";
  }
  return session;
}

function cancelCodexAuthorization(id) {
  const session = getCodexAuthorization(id);
  if (!session) return false;
  if (session.status === "pending") session.status = "cancelled";
  return true;
}

async function completeCodexAuthorization(id, rawCallbackUrl) {
  const session = getCodexAuthorization(id);
  if (!session) throw oauthError("Codex OAuth session not found", { statusCode: 404 });
  if (session.status !== "pending") throw oauthError(session.error || "Codex OAuth session is no longer pending", { statusCode: 409 });
  const url = callbackUrl(rawCallbackUrl);
  const returnedState = String(url.searchParams.get("state") || "");
  const code = String(url.searchParams.get("code") || "");
  const returnedError = String(url.searchParams.get("error") || url.searchParams.get("error_description") || "");
  if (returnedState !== session.id) throw oauthError("The callback URL does not match this Codex authorization", { statusCode: 400 });
  if (returnedError) {
    session.status = "failed";
    session.error = `Codex authorization was declined: ${returnedError}`;
    throw oauthError(session.error, { statusCode: 400 });
  }
  if (!code) throw oauthError("The callback URL does not contain an authorization code", { statusCode: 400 });
  try {
    session.credentials = await exchangeAuthorizationCode(code, session.codeVerifier);
    session.status = "completed";
    session.error = null;
    return session;
  } catch (error) {
    session.status = "failed";
    session.error = error.message || "Codex authorization failed";
    throw error;
  }
}

function finalizeCodexAuthorization(id, channelId) {
  const session = getCodexAuthorization(id);
  if (!session || session.status !== "completed" || !session.credentials) return null;
  session.channelId = channelId;
  const credentials = session.credentials;
  session.credentials = null;
  return credentials;
}

async function refreshCredentials(credentials) {
  const payload = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    scope: "openid profile email"
  });
  const response = await requestJson(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: payload,
    signal: AbortSignal.timeout(30000)
  });
  const next = tokenCredentials(response, credentials);
  if (!next.accessToken || !next.refreshToken) throw oauthError("Codex OAuth refresh returned incomplete tokens");
  return next;
}

async function refreshChannelCredentials(channel) {
  if (!isCodexOAuthChannel(channel)) throw oauthError("Codex OAuth credentials are not configured");
  const old = channel.codexOAuth.credentials;
  const key = old.refreshToken;
  let refresh = refreshInFlight.get(key);
  if (!refresh) {
    refresh = refreshCredentials(old).finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, refresh);
  }
  const next = await refresh;
  const previousQuota = channel.codexOAuth.quota;
  const previousQuotaError = channel.codexOAuth.quotaError;
  channel.codexOAuth = {
    ...storedOAuthInfo(next, { lastRefreshAt: new Date().toISOString(), status: "active" }),
    ...(previousQuota ? { quota: previousQuota } : {}),
    ...(previousQuotaError ? { quotaError: previousQuotaError } : {})
  };
  channel.updatedAt = new Date().toISOString();
  queueDbSave();
  return next;
}

async function channelCredentials(channel, options = {}) {
  if (!isCodexOAuthChannel(channel)) throw oauthError("Codex OAuth credentials are not configured");
  let credentials = channel.codexOAuth.credentials;
  const expiresAt = Date.parse(credentials.expiresAt || "");
  if (options.forceRefresh || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + CODEX_REFRESH_LEAD_MS) {
    try {
      credentials = await refreshChannelCredentials(channel);
    } catch (error) {
      if ([400, 401, 403].includes(Number(error.upstreamStatus))) {
        channel.codexOAuth.status = "reauthorization_required";
        channel.updatedAt = new Date().toISOString();
        queueDbSave();
      }
      throw error;
    }
  }
  return credentials;
}

function codexHeaders(credentials, stream) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${credentials.accessToken}`,
    accept: stream ? "text/event-stream" : "application/json",
    connection: "Keep-Alive",
    originator: "codex-tui",
    "user-agent": "codex-tui/0.153.3 (ModelPort OAuth adapter)"
  };
  if (credentials.accountId) headers["chatgpt-account-id"] = credentials.accountId;
  return headers;
}

function codexModelHeaders(credentials) {
  return {
    ...codexHeaders(credentials, false),
    accept: "application/json",
    connection: "close",
    originator: "codex_cli_rs",
    "user-agent": "codex_cli_rs/0.153.3 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9"
  };
}

function modelId(model) {
  if (typeof model === "string") return model.trim();
  return String(model?.slug || model?.id || model?.model || "").trim();
}

function firstQuotaValue(source, names) {
  for (const name of names) {
    if (source && Object.hasOwn(source, name) && source[name] !== null && source[name] !== undefined) return source[name];
  }
  return undefined;
}

function quotaNumber(source, names) {
  const value = Number(firstQuotaValue(source, names));
  return Number.isFinite(value) ? value : null;
}

function quotaResetAt(window) {
  const exact = timestampToIso(firstQuotaValue(window, ["reset_at", "resetAt", "resets_at", "resetsAt"]));
  if (exact) return exact;
  const seconds = quotaNumber(window, ["reset_after_seconds", "resetAfterSeconds", "resets_in_seconds", "resetsInSeconds"]);
  return seconds !== null && seconds >= 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

function quotaWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = quotaNumber(window, ["used_percent", "usedPercent"]);
  const windowMinutes = quotaNumber(window, ["window_minutes", "windowMinutes"])
    ?? (() => {
      const seconds = quotaNumber(window, ["window_seconds", "windowSeconds", "limit_window_seconds", "limitWindowSeconds"]);
      return seconds === null ? null : seconds / 60;
    })();
  const resetAt = quotaResetAt(window);
  if (usedPercent === null && windowMinutes === null && !resetAt) return null;
  return {
    ...(usedPercent === null ? {} : { usedPercent: Math.max(0, Math.min(100, usedPercent)) }),
    ...(windowMinutes === null ? {} : { windowMinutes }),
    ...(resetAt ? { resetAt } : {})
  };
}

function parseCodexQuota(body) {
  const rateLimits = firstQuotaValue(body, ["rate_limits", "rateLimits", "rate_limit", "rateLimit"]) || {};
  const primary = quotaWindow(firstQuotaValue(rateLimits, ["primary", "primary_window", "primaryWindow"]));
  const secondary = quotaWindow(firstQuotaValue(rateLimits, ["secondary", "secondary_window", "secondaryWindow"]));
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(typeof body?.plan_type === "string" ? { planType: body.plan_type } : {}),
    ...(typeof body?.planType === "string" ? { planType: body.planType } : {}),
    fetchedAt: new Date().toISOString()
  };
}

async function fetchCodexModels(channel) {
  const url = new URL(`${CODEX_UPSTREAM_BASE}/models`);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  const requestUrl = url.toString();
  const requestModels = async credentials => {
    try {
      return await outboundFetch(requestUrl, {
        headers: codexModelHeaders(credentials),
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      const cause = error?.cause;
      const detail = String(cause?.code || cause?.message || error?.message || "network request failed").trim();
      throw oauthError(`Codex model request failed: ${detail}`, { upstreamUrl: requestUrl });
    }
  };
  let credentials = await channelCredentials(channel);
  let response = await requestModels(credentials);
  if (response.status === 401 || response.status === 403) {
    credentials = await channelCredentials(channel, { forceRefresh: true });
    response = await requestModels(credentials);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body?.error?.message || body?.error || "").trim();
    throw oauthError(`Codex model fetch failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`, {
      upstreamStatus: response.status,
      upstreamUrl: requestUrl,
      upstreamBody: body
    });
  }
  const seen = new Set();
  return [...(Array.isArray(body?.models) ? body.models : []).map(modelId), ...CODEX_IMAGE_MODELS]
    .filter(id => id && !seen.has(id) && seen.add(id));
}

async function fetchCodexQuota(channel) {
  const requestQuota = async credentials => {
    try {
      return await outboundFetch(CODEX_QUOTA_URL, {
        headers: codexModelHeaders(credentials),
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      const cause = error?.cause;
      const detail = String(cause?.code || cause?.message || error?.message || "network request failed").trim();
      throw oauthError(`Codex quota request failed: ${detail}`, { upstreamUrl: CODEX_QUOTA_URL });
    }
  };
  let credentials = await channelCredentials(channel);
  let response = await requestQuota(credentials);
  if (response.status === 401 || response.status === 403) {
    credentials = await channelCredentials(channel, { forceRefresh: true });
    response = await requestQuota(credentials);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(body?.error?.message || body?.error || "").trim();
    throw oauthError(`Codex quota fetch failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`, {
      upstreamStatus: response.status,
      upstreamUrl: CODEX_QUOTA_URL,
      upstreamBody: body
    });
  }
  return parseCodexQuota(body);
}

async function refreshCodexQuota(channel) {
  if (!isCodexOAuthChannel(channel)) throw oauthError("Codex OAuth credentials are not configured");
  const quota = await fetchCodexQuota(channel);
  channel.codexOAuth.quota = quota;
  if (quota.planType) channel.codexOAuth.planType = quota.planType;
  delete channel.codexOAuth.quotaError;
  channel.updatedAt = new Date().toISOString();
  queueDbSave();
  return quota;
}

async function requestCodexResponse(channel, modelId, body, signal) {
  const requestBody = { ...body, model: modelId };
  let credentials = await channelCredentials(channel);
  let response = await outboundFetch(`${CODEX_UPSTREAM_BASE}/responses`, {
    method: "POST",
    headers: codexHeaders(credentials, body.stream === true),
    body: JSON.stringify(requestBody),
    signal
  });
  if (response.status === 401 || response.status === 403) {
    credentials = await channelCredentials(channel, { forceRefresh: true });
    response = await outboundFetch(`${CODEX_UPSTREAM_BASE}/responses`, {
      method: "POST",
      headers: codexHeaders(credentials, body.stream === true),
      body: JSON.stringify(requestBody),
      signal
    });
  }
  return response;
}

async function requestCodexImage(channel, modelId, body, signal, action = "generations") {
  if (!isCodexImageModel(modelId)) {
    throw oauthError(`Unsupported Codex image model: ${modelId}`, { upstreamStatus: 400 });
  }
  const requestUrl = `${CODEX_UPSTREAM_BASE}/images/${action}`;
  const requestBody = { ...body, model: modelId };
  const requestImage = credentials => outboundFetch(requestUrl, {
    method: "POST",
    headers: codexHeaders(credentials, body.stream === true),
    body: JSON.stringify(requestBody),
    signal
  });
  let credentials = await channelCredentials(channel);
  let response = await requestImage(credentials);
  if (response.status === 401 || response.status === 403) {
    credentials = await channelCredentials(channel, { forceRefresh: true });
    response = await requestImage(credentials);
  }
  return response;
}

module.exports = {
  CODEX_CALLBACK_URI,
  CODEX_CLIENT_VERSION,
  CODEX_IMAGE_MODELS,
  CODEX_QUOTA_URL,
  CODEX_UPSTREAM_BASE,
  DEFAULT_CODEX_MODELS,
  cancelCodexAuthorization,
  completeCodexAuthorization,
  defaultCodexModels,
  fetchCodexQuota,
  fetchCodexModels,
  finalizeCodexAuthorization,
  getCodexAuthorization,
  isCodexImageModel,
  isCodexOAuthChannel,
  parseIdToken,
  parseCodexQuota,
  publicOAuthInfo,
  requestCodexResponse,
  requestCodexImage,
  refreshCodexQuota,
  sessionPublic,
  startCodexAuthorization,
  storedOAuthInfo
};
