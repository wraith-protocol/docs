// Disposable local health endpoint used by the operator runbook check.
// Serves the same paths readers hit in the monitoring guide, but against
// localhost so no network or secrets are required.
import http from "node:http";

const port = Number(process.env.OPERATOR_RUNBOOK_PORT || 18765);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "wraith-spectre", version: "1.0.0" }));
    return;
  }
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("# HELP wraith_rpc_latency_seconds RPC latency\nwraith_rpc_latency_seconds 0.1\n");
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`operator-runbook fixture listening on http://127.0.0.1:${port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
