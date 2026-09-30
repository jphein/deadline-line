// aai.js — AssemblyAI Universal-Streaming (v3) client.
// Send raw PCM16 little-endian mono audio; receive Turn events. The API key stays server-side.
// Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const AAI_URL = process.env.AAI_STREAMING_URL || "wss://streaming.assemblyai.com/v3/ws";

// Universal-Streaming takes 50 to 1000 ms of audio per message and ends the session on anything else
// ("Input Duration Violation"). Asterisk's AudioSocket delivers 20 ms frames, so audio is gathered until
// there is at least 50 ms, a longer burst is split into 1000 ms pieces, and the last scrap is padded with
// silence at close. The browser already posts 50 ms chunks, so those go straight through.
export const CHUNK_MS = { min: 50, max: 1000 };

/** The query for one streaming session: raw PCM16, formatted turns, key terms. The server's sessions and the
 *  page's direct sessions on Vercel (src/vercel.js) both open with it. */
export function streamingQuery(sampleRate, keyterms = []) {
  const q = new URLSearchParams({ sample_rate: String(sampleRate), encoding: "pcm_s16le", format_turns: "true" });
  if (keyterms.length) q.set("keyterms_prompt", JSON.stringify(keyterms));
  return q;
}

export class AaiStream extends EventEmitter {
  /**
   * @param {{ apiKey?: string, sampleRate: number, url?: string, keyterms?: string[] }} opts
   * Emits: "open", "turn" ({ text, final }), "error", "close".
   */
  constructor({ apiKey = process.env.ASSEMBLYAI_API_KEY, sampleRate, url = AAI_URL, keyterms = [] }) {
    super();
    if (!apiKey && url === "wss://streaming.assemblyai.com/v3/ws") throw new Error("ASSEMBLYAI_API_KEY is not set");
    if (!(Number.isFinite(sampleRate) && sampleRate > 0)) throw new Error("sampleRate must be a positive number");
    const bytes = (ms) => Math.round((sampleRate * 2 * ms) / 1000) & ~1;   // PCM16 mono: 2 bytes per sample
    this.chunk = { min: bytes(CHUNK_MS.min), max: bytes(CHUNK_MS.max) };
    this.buf = Buffer.alloc(0);
    this.ws = new WebSocket(`${url}?${streamingQuery(sampleRate, keyterms)}`, { headers: apiKey ? { Authorization: apiKey } : {} });
    this.ready = false;
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "Begin") { this.ready = true; this.flush(); this.emit("open", msg); }
      else if (msg.type === "Turn") {
        // With format_turns, the final, punctuated transcript arrives with end_of_turn && turn_is_formatted.
        const final = Boolean(msg.end_of_turn && msg.turn_is_formatted);
        if (msg.transcript) this.emit("turn", { text: msg.transcript, final });
      } else if (msg.type === "Termination") this.emit("terminated", msg);
      else if (msg.error) this.emit("error", new Error(msg.error));
    });
    this.ws.on("error", (e) => this.emit("error", e));
    this.ws.on("close", (code, reason) => this.emit("close", { code, reason: reason.toString() }));
  }

  /** Queue PCM16 audio; it goes out in 50 to 1000 ms messages. @param {Buffer} pcm */
  send(pcm) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, pcm]) : Buffer.from(pcm);
    this.flush();
  }

  /** Send every whole chunk that is ready. With final, also the rest, padded with silence to 50 ms. */
  flush(final = false) {
    if (this.ws.readyState !== WebSocket.OPEN || !this.ready) return;   // kept until Begin arrives
    const { min, max } = this.chunk;
    while (this.buf.length >= min) {
      const n = Math.min(this.buf.length, max) & ~1;
      this.ws.send(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
    }
    if (final && this.buf.length) {
      this.ws.send(Buffer.concat([this.buf, Buffer.alloc(min - this.buf.length)]));
      this.buf = Buffer.alloc(0);
    }
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) {
      try { this.flush(true); this.ws.send(JSON.stringify({ type: "Terminate" })); } catch {}
      setTimeout(() => this.ws.close(), 500).unref?.();
    } else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }
}

// Words the recognizer should expect on this line (boosts accuracy on legal/benefits vocabulary).
export const KEYTERMS = ["Social Security", "reconsideration", "unlawful detainer", "summons", "three day notice",
  "eviction", "Medi-Cal", "CalFresh", "Notice of Action", "SSI", "disability", "landlord"];
