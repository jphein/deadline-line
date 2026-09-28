// tts.js — text to PCM16 mono at a requested sample rate.
// Backends: Wyoming Piper (a local/homelab neural voice, e.g. TTS_WYOMING=piper-host:10200) or espeak-ng.
import net from "node:net";
import { spawn } from "node:child_process";

/** Linear resample of PCM16LE mono. Good enough for 8 kHz telephony; not audiophile. */
export function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inN = pcm.length >> 1, outN = Math.floor(inN * toRate / fromRate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = i * fromRate / toRate, j = Math.floor(x), f = x - j;
    const a = pcm.readInt16LE(Math.min(j, inN - 1) * 2), b = pcm.readInt16LE(Math.min(j + 1, inN - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}

export function wyomingSynth(text, hostport) {
  const [host, port] = hostport.split(":");
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(port || 10200), host);
    let buf = Buffer.alloc(0), rate = 22050; const chunks = [];
    const timer = setTimeout(() => { s.destroy(); reject(new Error("wyoming tts timeout")); }, 20000);
    s.on("connect", () => s.write(JSON.stringify({ type: "synthesize", data: { text } }) + "\n"));
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const nl = buf.indexOf(10); if (nl < 0) return;
        const h = JSON.parse(buf.subarray(0, nl).toString());
        const dl = h.data_length || 0, pl = h.payload_length || 0;
        if (buf.length < nl + 1 + dl + pl) return;
        const data = dl ? JSON.parse(buf.subarray(nl + 1, nl + 1 + dl).toString()) : (h.data || {});
        if (h.type === "audio-start") rate = data.rate;
        if (h.type === "audio-chunk" && pl) chunks.push(Buffer.from(buf.subarray(nl + 1 + dl, nl + 1 + dl + pl)));
        buf = buf.subarray(nl + 1 + dl + pl);
        if (h.type === "audio-stop") { clearTimeout(timer); s.end(); return resolve({ pcm: Buffer.concat(chunks), rate }); }
      }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export function espeakSynth(text) {
  return new Promise((resolve, reject) => {
    const p = spawn("espeak-ng", ["-v", "en-us", "-s", "155", "--stdout", text]);
    const chunks = []; p.stdout.on("data", c => chunks.push(c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`espeak-ng exited ${code}`));
      const wav = Buffer.concat(chunks);
      // Find the "data" chunk; espeak writes 22050 Hz mono s16 (with a streaming-size header).
      const rate = wav.readUInt32LE(24);
      const di = wav.indexOf("data", 12);
      resolve({ pcm: wav.subarray(di + 8), rate });
    });
  });
}

/** @returns {Promise<Buffer>} PCM16LE mono at `rate` */
export async function synth(text, rate, { wyoming = process.env.TTS_WYOMING } = {}) {
  let out;
  if (wyoming) {
    try { out = await wyomingSynth(text, wyoming); } catch (e) { console.warn(`tts: wyoming failed (${e.message}); using espeak-ng`); }
  }
  out ??= await espeakSynth(text);
  return resample(out.pcm, out.rate, rate);
}
