#!/usr/bin/env node
// server.js — web demo on :8770 and the Asterisk AudioSocket bridge on :9092.
// Deadline rules come from the Deadline Decoder MCP server at DD_MCP_URL; if unset, one is started
// in-process on 127.0.0.1:8766.
import { createWeb } from "./web.js";
import { startAudioSocketServer } from "./audiosocket.js";
import { mcpClient } from "./mcpclient.js";

let mcpUrl = process.env.DD_MCP_URL;
if (!mcpUrl) {
  const { createApp } = await import("../vendor/deadline-decoder-mcp/src/server.js");
  await new Promise(r => createApp().listen(8766, "127.0.0.1", r));
  mcpUrl = "http://127.0.0.1:8766/mcp";
  console.log(`deadline-decoder MCP (embedded) on ${mcpUrl}`);
}
const callTool = mcpClient(mcpUrl);
if (!process.env.ASSEMBLYAI_API_KEY) console.warn("ASSEMBLYAI_API_KEY is not set: speech-to-text will fail (the typed fallback still works).");

const webPort = Number(process.env.PORT || 8770), webHost = process.env.HOST || "127.0.0.1";
const { app, attach } = createWeb({ callTool });
const http = app.listen(webPort, webHost, () => console.log(`web demo on http://${webHost}:${webPort}/`));
attach(http);

const asPort = Number(process.env.AUDIOSOCKET_PORT || 9092), asHost = process.env.AUDIOSOCKET_HOST || "127.0.0.1";
await startAudioSocketServer({ port: asPort, host: asHost, callTool });
console.log(`AudioSocket bridge on ${asHost}:${asPort} (point a LOCAL Asterisk's AudioSocket() here)`);
