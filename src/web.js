// web.js — browser demo: mic audio (PCM16, 16 kHz) over a WebSocket -> AssemblyAI streaming ->
// the same Dialog the phone uses. Replies go back as text; the page plays them with the same
// neural voice via /tts (or the browser's own voice).
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { AaiStream, KEYTERMS } from "./aai.js";
import { Dialog, GREETING } from "./dialog.js";
import { synth } from "./tts.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function createWeb({ callTool, stt = (rate) => new AaiStream({ sampleRate: rate, keyterms: KEYTERMS }), tts = synth, today } = {}) {
  const app = express();
  app.use(express.static(path.join(here, "..", "public")));
  app.get("/healthz", (_q, r) => r.json({ ok: true, stt: process.env.ASSEMBLYAI_API_KEY ? "assemblyai" : "missing key", tts: process.env.TTS_WYOMING || "espeak-ng" }));
  app.get("/tts", async (req, res) => {
    const text = String(req.query.text || "").slice(0, 1200);
    if (!text) return res.status(400).end();
    try { res.type("audio/wav").send(wav(await tts(text, 22050), 22050)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  const attach = (server) => {
    const wss = new WebSocketServer({ server, path: "/listen" });
    wss.on("connection", (ws) => {
      const dialog = new Dialog(callTool, { today });
      let recognizer, busy = false;
      const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
      try { recognizer = stt(16000); }
      catch (e) { send({ type: "error", text: e.message }); return ws.close(); }
      send({ type: "line", text: GREETING });
      recognizer.on("turn", async ({ text, final }) => {
        if (!final) return send({ type: "partial", text });
        if (busy) return;
        busy = true; send({ type: "caller", text });
        try { const r = await dialog.handle(text); send({ type: "line", text: r.say, done: r.done }); }
        catch (e) { send({ type: "error", text: e.message }); }
        finally { busy = false; }
      });
      recognizer.on("error", (e) => send({ type: "error", text: `speech-to-text: ${e.message}` }));
      ws.on("message", (data, isBinary) => {
        if (isBinary) return recognizer.send(Buffer.from(data));
        // Typed fallback, for demos without a microphone.
        try { const m = JSON.parse(data.toString()); if (m.type === "text") recognizer.emit("turn", { text: m.text, final: true }); } catch {}
      });
      ws.on("close", () => recognizer.close());
    });
    return wss;
  };
  return { app, attach };
}
