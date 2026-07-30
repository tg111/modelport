const DEFAULT_SETTINGS = Object.freeze({
  textTimeoutSeconds: 120,
  imageTimeoutSeconds: 300,
  circuitFailureThreshold: 3,
  circuitCooldownSeconds: 60,
  authFailureCooldownSeconds: 900
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
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const [min, max] = SETTING_RANGES[key];
    const value = Number(input[key]);
    settings[key] = Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }
  return settings;
}

function validateSettings(input = {}) {
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const [min, max] = SETTING_RANGES[key];
    const value = input[key] === undefined ? fallback : Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      const error = new Error(`${key} must be an integer between ${min} and ${max}`);
      error.statusCode = 400;
      throw error;
    }
    settings[key] = value;
  }
  return settings;
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeSettings,
  validateSettings
};
