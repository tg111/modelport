const clientConfig = require("../config/codex-client.json");

const CODEX_CLIENT_VERSION = String(clientConfig.version || "").trim();

if (!/^\d+\.\d+\.\d+$/.test(CODEX_CLIENT_VERSION)) {
  throw new Error("config/codex-client.json must define a semantic Codex client version");
}

const CODEX_TUI_USER_AGENT = `codex-tui/${CODEX_CLIENT_VERSION} (ModelPort OAuth adapter)`;
const CODEX_CLI_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION} (Mac OS 26.3.1; arm64) iTerm.app/3.6.9`;

module.exports = {
  CODEX_CLIENT_VERSION,
  CODEX_TUI_USER_AGENT,
  CODEX_CLI_USER_AGENT
};
