const DEFAULT_SETTINGS = Object.freeze({
  textTimeoutSeconds: 120,
  imageTimeoutSeconds: 300,
  circuitFailureThreshold: 3,
  circuitCooldownSeconds: 60,
  authFailureCooldownSeconds: 900,
  outboundProxyEnabled: false,
  outboundProxyUrl: ""
});

const SETTING_RANGES = Object.freeze({
  textTimeoutSeconds: [1, 3600],
  imageTimeoutSeconds: [1, 3600],
  circuitFailureThreshold: [1, 100],
  circuitCooldownSeconds: [1, 86400],
  authFailureCooldownSeconds: [1, 86400]
});

function normalizeSettings(input = {}) {
  const settings = {};
  for (const [key, fallback] of Object.entries(SETTING_RANGES)) {
    const defaultValue = DEFAULT_SETTINGS[key];
    const [min, max] = SETTING_RANGES[key];
    const value = Number(input[key]);
    settings[key] = Number.isInteger(value) && value >= min && value <= max ? value : defaultValue;
  }
  settings.outboundProxyEnabled = input.outboundProxyEnabled === true || input.outboundProxyEnabled === "true";
  settings.outboundProxyUrl = normalizeProxyUrl(input.outboundProxyUrl);
  if (!settings.outboundProxyUrl) settings.outboundProxyEnabled = false;
  return settings;
}

function validateSettings(input = {}) {
  const settings = {};
  for (const [key, fallback] of Object.entries(SETTING_RANGES)) {
    const [min, max] = SETTING_RANGES[key];
    const value = input[key] === undefined ? DEFAULT_SETTINGS[key] : Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      const error = new Error(`${key} must be an integer between ${min} and ${max}`);
      error.statusCode = 400;
      throw error;
    }
    settings[key] = value;
  }
  const enabled = input.outboundProxyEnabled === undefined ? DEFAULT_SETTINGS.outboundProxyEnabled : input.outboundProxyEnabled;
  if (![true, false, "true", "false"].includes(enabled)) {
    const error = new Error("outboundProxyEnabled must be true or false");
    error.statusCode = 400;
    throw error;
  }
  settings.outboundProxyEnabled = enabled === true || enabled === "true";
  settings.outboundProxyUrl = normalizeProxyUrl(input.outboundProxyUrl);
  if (String(input.outboundProxyUrl || "").trim() && !settings.outboundProxyUrl) {
    const error = new Error("outboundProxyUrl must be a valid HTTP or HTTPS proxy URL");
    error.statusCode = 400;
    throw error;
  }
  if (settings.outboundProxyEnabled && !settings.outboundProxyUrl) {
    const error = new Error("outboundProxyUrl is required when outbound proxy is enabled");
    error.statusCode = 400;
    throw error;
  }
  return settings;
}

function normalizeProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return "";
    return url.toString();
  } catch {
    return "";
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeSettings,
  validateSettings
};
