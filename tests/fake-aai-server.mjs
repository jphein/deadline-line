// Dev tool: a scripted stand-in for AssemblyAI streaming, for rehearsing the phone path without a key.
// After ~N seconds of received audio it "hears" the next scripted sample line (sample letters only).
import { WebSocketServer } from "ws";
const port = Number(process.env.FAKE_AAI_PORT || 8799);
const script = [
  "I got a letter from Social Security dated September 13th. They denied my disability again.",
  "Yes, how did you count?",
  "No thanks. Goodbye.",
];
const wss = new WebSocketServer({ port, host: "127.0.0.1" });
wss.on("connection", (ws, req) => {
  const rate = Number(new URL(req.url, "http://x").searchParams.get("sample_rate")) || 8000;
  let bytes = 0, next = 0, lastTurnAt = 0;
  ws.send(JSON.stringify({ type: "Begin", id: "fake" }));
  ws.on("message", (d, bin) => {
    if (!bin) { if (JSON.parse(d).type === "Terminate") ws.send(JSON.stringify({ type: "Termination" })); return; }
    bytes += d.length;
    const secs = bytes / (rate * 2);
    // one scripted turn every ~14 s of caller audio (leaves room for the line's answer to play)
    if (next < script.length && secs - lastTurnAt > (next === 0 ? 9 : 14)) {
      lastTurnAt = secs;
      ws.send(JSON.stringify({ type: "Turn", transcript: script[next++], end_of_turn: true, turn_is_formatted: true }));
    }
  });
});
console.log(`fake AssemblyAI on ws://127.0.0.1:${port}/v3/ws`);
