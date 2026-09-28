import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { createApp } from "../vendor/deadline-decoder-mcp/src/server.js";
import { mcpClient } from "../src/mcpclient.js";

export const TODAY = "2026-09-26";

/** Real Deadline Decoder MCP server on an ephemeral port. */
export async function startMcp() {
  const server = createApp({ now: () => new Date(`${TODAY}T19:00:00Z`) }).listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  return { callTool: mcpClient(`http://127.0.0.1:${server.address().port}/mcp`), close: () => new Promise(r => server.close(r)) };
}

/** A fake AssemblyAI v3 streaming endpoint that records what it receives. */
export async function startFakeAai() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise(r => wss.once("listening", r));
  const state = { bytes: 0, url: null, auth: null, sockets: [], terminated: false };
  wss.on("connection", (ws, req) => {
    state.url = req.url; state.auth = req.headers.authorization; state.sockets.push(ws);
    ws.send(JSON.stringify({ type: "Begin", id: "fake", expires_at: 0 }));
    ws.on("message", (d, isBinary) => {
      if (isBinary) state.bytes += d.length;
      else if (JSON.parse(d.toString()).type === "Terminate") { state.terminated = true; ws.send(JSON.stringify({ type: "Termination" })); }
    });
  });
  return {
    url: `ws://127.0.0.1:${wss.address().port}/v3/ws`, state,
    turn: (text, { final = true } = {}) => state.sockets.at(-1).send(JSON.stringify({ type: "Turn", transcript: text, end_of_turn: final, turn_is_formatted: final })),
    close: () => new Promise(r => { state.sockets.forEach(s => s.terminate()); wss.close(r); }),
  };
}

/** Stand-in recognizer for bridge tests: records audio, lets the test inject turns. */
export function fakeStt() {
  const e = new EventEmitter(); e.bytes = 0; e.closed = false;
  e.send = (b) => { e.bytes += b.length; }; e.close = () => { e.closed = true; };
  return e;
}
export const fakeTts = async (text) => Buffer.alloc(Math.min(1280, 32 * text.length)); // 32 bytes/char, capped
