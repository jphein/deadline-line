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

/** A fake AssemblyAI v3 streaming endpoint that records what it receives. Like the real service, it
 *  accepts 50 to 1000 ms of audio per message, and on anything else sends the same error and ends the session. */
export async function startFakeAai() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise(r => wss.once("listening", r));
  const state = { bytes: 0, url: null, auth: null, sockets: [], terminated: false, chunksMs: [], violations: 0 };
  wss.on("connection", (ws, req) => {
    state.url = req.url; state.auth = req.headers.authorization; state.sockets.push(ws);
    const rate = Number(new URL(req.url, "http://x").searchParams.get("sample_rate")) || 16000;
    ws.send(JSON.stringify({ type: "Begin", id: "fake", expires_at: 0 }));
    ws.on("message", (d, isBinary) => {
      if (isBinary) {
        state.bytes += d.length;
        const ms = (d.length / (rate * 2)) * 1000;
        state.chunksMs.push(ms);
        if (ms < 50 || ms > 1000) {
          state.violations++;
          ws.send(JSON.stringify({ error: `Input Duration Error: Input Duration Violation: ${ms.toFixed(1)} ms. Expected between 50 and 1000 ms` }));
          ws.close(3007, "Input duration violation");
        }
      }
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
