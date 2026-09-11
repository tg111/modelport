const DEFAULT_CHANNEL_PRIORITY = 1;
const MAX_CHANNEL_PRIORITY = 1000;

function normalizeChannelPriority(value, fallback = DEFAULT_CHANNEL_PRIORITY) {
  const normalizedFallback = Number.isFinite(Number(fallback))
    ? Math.min(MAX_CHANNEL_PRIORITY, Math.max(DEFAULT_CHANNEL_PRIORITY, Math.trunc(Number(fallback))))
    : DEFAULT_CHANNEL_PRIORITY;
  if (value === undefined || value === null || value === "") return normalizedFallback;
  const priority = Number(value);
  if (!Number.isFinite(priority)) return normalizedFallback;
  return Math.min(MAX_CHANNEL_PRIORITY, Math.max(DEFAULT_CHANNEL_PRIORITY, Math.trunc(priority)));
}

module.exports = {
  DEFAULT_CHANNEL_PRIORITY,
  MAX_CHANNEL_PRIORITY,
  normalizeChannelPriority
};
