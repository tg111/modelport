const http = require("http");
const {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  PORT,
  ensureData,
  state
} = require("./state");
const { sendError } = require("./http");
const { route } = require("./routes");

ensureData();

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    if (!res.headersSent) sendError(res, error.statusCode || 500, error.message || "Internal server error");
    else res.destroy(error);
  });
});

server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = Math.max(HEADERS_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS + 1000);

server.on("clientError", (error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("error", error => {
  console.error(`Server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  console.log(`modelport listening on http://0.0.0.0:${PORT}`);
  console.log(`admin/proxy api key: ${state.apiKey}`);
});
