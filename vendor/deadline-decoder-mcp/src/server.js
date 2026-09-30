#!/usr/bin/env node
// Vendored from jphein/deadline-decoder-mcp (develop @ 99652d1), licensed AGPL-3.0-or-later: see vendor/deadline-decoder-mcp/LICENSE.
// Upstream edits belong upstream: change them there and re-vendor with scripts/vendor-decoder.sh, rather than patch here.
// server.js — Streamable HTTP MCP endpoint at /mcp (stateless, spec 2025-11-25) plus the web
// Alexa+ simulator at /. Set HOST=0.0.0.0 and ALLOWED_HOSTS=example.org behind a reverse proxy.
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_INFO } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ host = "127.0.0.1", allowedHosts, now } = {}) {
  const app = createMcpExpressApp({ host, allowedHosts });

  app.post("/mcp", async (req, res) => {
    const server = createMcpServer({ now });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("mcp error:", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  // Stateless server: no server-initiated streams or sessions to delete.
  const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.get("/healthz", (_req, res) => res.json({ ok: true, ...SERVER_INFO }));
  app.use(express.static(path.join(here, "..", "public")));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8766);
  const allowedHosts = process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(",") : undefined;
  createApp({ host, allowedHosts }).listen(port, host, () => {
    console.log(`deadline-decoder MCP on http://${host}:${port}/mcp  (simulator: http://${host}:${port}/)`);
  });
}
