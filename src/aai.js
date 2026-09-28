// aai.js — AssemblyAI Universal-Streaming (v3) client.
// Send raw PCM16 little-endian mono audio; receive Turn events. The API key stays server-side.
// Docs: https://www.assemblyai.com/docs/speech-to-text/universal-streaming
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const AAI_URL = process.env.AAI_STREAMING_URL || "wss://streaming.assemblyai.com/v3/ws";

export class AaiStream extends EventEmitter {
  /**
   * @param {{ apiKey?: string, sampleRate: number, url?: string, keyterms?: string[] }} opts
   * Emits: "open", "turn" ({ text, final }), "error", "close".
   */
  constructor({ apiKey = process.env.ASSEMBLYAI_API_KEY, sampleRate, url = AAI_URL, keyterms = [] }) {
    super();
    if (!apiKey && url === "wss://streaming.assemblyai.com/v3/ws") throw new Error("ASSEMBLYAI_API_KEY is not set");
    const q = new URLSearchParams({ sample_rate: String(sampleRate), encoding: "pcm_s16le", format_turns: "true" });
    if (keyterms.length) q.set("keyterms_prompt", JSON.stringify(keyterms));
    this.ws = new WebSocket(`${url}?${q}`, { headers: apiKey ? { Authorization: apiKey } : {} });
    this.ready = false;
    this.pending = [];
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "Begin") { this.ready = true; this.pending.forEach(b => this.ws.send(b)); this.pending = []; this.emit("open", msg); }
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

  /** @param {Buffer} pcm */
  send(pcm) {
    if (this.ws.readyState !== WebSocket.OPEN || !this.ready) { this.pending.push(pcm); return; }
    this.ws.send(pcm);
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: "Terminate" })); } catch {}
      setTimeout(() => this.ws.close(), 500).unref?.();
    } else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }
}

// Words the recognizer should expect on this line (boosts accuracy on legal/benefits vocabulary).
export const KEYTERMS = ["Social Security", "reconsideration", "unlawful detainer", "summons", "three day notice",
  "eviction", "Medi-Cal", "CalFresh", "Notice of Action", "SSI", "disability", "landlord"];
