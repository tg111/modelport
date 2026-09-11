const { ProxyAgent, fetch: undiciFetch } = require("undici");
const { state } = require("./state");

let cachedUrl = "";
let cachedDispatcher = null;

function configuredProxyUrl() {
  const settings = state.db?.settings || {};
  return settings.outboundProxyEnabled ? String(settings.outboundProxyUrl || "").trim() : "";
}

function closeDispatcher(dispatcher) {
  try {
    const closing = dispatcher?.close?.();
    if (closing?.catch) closing.catch(() => {});
  } catch {}
}

function outboundDispatcher() {
  const url = configuredProxyUrl();
  if (url === cachedUrl) return cachedDispatcher;
  closeDispatcher(cachedDispatcher);
  cachedUrl = url;
  cachedDispatcher = url ? new ProxyAgent(url) : null;
  return cachedDispatcher;
}

function outboundFetch(url, options = {}) {
  const dispatcher = outboundDispatcher();
  return dispatcher ? undiciFetch(url, { ...options, dispatcher }) : fetch(url, options);
}

module.exports = {
  outboundDispatcher,
  outboundFetch
};
