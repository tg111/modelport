const http = require("http");
const { URL } = require("url");
const { completeCodexOAuthCallback } = require("./api");
const { CODEX_CALLBACK_URI } = require("./codex-oauth");

const CODEX_CALLBACK_PORT = 1455;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function callbackPage(title, message, tone = "success") {
  return `<!doctype html>
<html lang="zh-CN">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #f8fafc; color: #0f172a; }
    main { width: min(420px, calc(100vw - 40px)); padding: 28px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; box-shadow: 0 12px 32px rgb(15 23 42 / 8%); }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0; color: #475569; line-height: 1.65; }
    .mark { width: 10px; height: 10px; margin-bottom: 16px; border-radius: 999px; background: ${tone === "success" ? "#22c55e" : "#ef4444"}; box-shadow: 0 0 0 5px ${tone === "success" ? "#dcfce7" : "#fee2e2"}; }
  </style>
  <main><div class="mark"></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
</html>`;
}

function sendPage(res, statusCode, title, message, tone) {
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(callbackPage(title, message, tone));
}

function createCodexCallbackHandler(complete = completeCodexOAuthCallback) {
  return async (req, res) => {
    const url = new URL(req.url || "/", CODEX_CALLBACK_URI);
    if (req.method !== "GET" || url.pathname !== "/auth/callback") {
      return sendPage(res, 404, "未找到回调页面", "请回到 ModelPort 管理页重新开始授权。", "error");
    }
    const sessionId = String(url.searchParams.get("state") || "");
    if (!sessionId) {
      return sendPage(res, 400, "授权回调无效", "回调链接缺少授权状态，请回到管理页重新开始授权。", "error");
    }

    const redirectUrl = new URL(CODEX_CALLBACK_URI);
    redirectUrl.search = url.search;
    try {
      await complete(sessionId, redirectUrl.toString());
      return sendPage(res, 200, "Codex 授权成功", "渠道已添加。你可以关闭此页面并返回 ModelPort。", "success");
    } catch (error) {
      return sendPage(res, error.statusCode || 400, "无法完成 Codex 授权", error.message || "请回到管理页粘贴回调链接后重试。", "error");
    }
  };
}

function startCodexCallbackListener() {
  const handler = createCodexCallbackHandler();
  const listener = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      if (!res.headersSent) sendPage(res, 500, "无法完成 Codex 授权", error.message || "内部错误", "error");
      else res.destroy(error);
    });
  });
  listener.on("error", error => {
    console.warn(`Codex OAuth callback listener is unavailable on localhost:${CODEX_CALLBACK_PORT}: ${error.message}`);
  });
  listener.listen(CODEX_CALLBACK_PORT, "127.0.0.1", () => {
    console.log(`Codex OAuth callback listener on http://localhost:${CODEX_CALLBACK_PORT}/auth/callback`);
  });
  return listener;
}

module.exports = {
  CODEX_CALLBACK_PORT,
  createCodexCallbackHandler,
  startCodexCallbackListener
};
