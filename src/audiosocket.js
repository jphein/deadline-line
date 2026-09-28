// audiosocket.js — Asterisk AudioSocket bridge (Asterisk 18+: app_audiosocket / res_audiosocket).
// Asterisk dials AudioSocket(<uuid>,<host>:<port>); each TCP connection is one call carrying
// frames of [type:1][length:2 BE][payload]. Types: 0x00 hangup, 0x01 UUID, 0x10 audio (signed
// linear 16-bit, 8 kHz, mono, little-endian), 0xff error. We answer with audio frames, paced at 20 ms.
import net from "node:net";
import { EventEmitter } from "node:events";
import { AaiStream, KEYTERMS } from "./aai.js";
import { Dialog, GREETING } from "./dialog.js";
import { synth } from "./tts.js";

export const T = { HANGUP: 0x00, UUID: 0x01, AUDIO: 0x10, ERROR: 0xff };
export const RATE = 8000;
const FRAME = 320; // 20 ms of 8 kHz s16

export function frame(type, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(3); h[0] = type; h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

/** Incremental parser: feed bytes, get complete frames. */
export function frameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 3) {
      const len = buf.readUInt16BE(1);
      if (buf.length < 3 + len) return;
      onFrame(buf[0], buf.subarray(3, 3 + len));
      buf = buf.subarray(3 + len);
    }
  };
}

/**
 * One phone call. Dependencies are injectable so tests run without Asterisk, AssemblyAI or TTS.
 * @param {net.Socket} sock
 * @param {{ callTool: Function, stt?: (rate:number)=>any, tts?: (text:string, rate:number)=>Promise<Buffer>, today?: string, log?: Function }} deps
 */
export function handleCall(sock, { callTool, stt = (rate) => new AaiStream({ sampleRate: rate, keyterms: KEYTERMS }),
  tts = synth, today, log = console.log }) {
  const dialog = new Dialog(callTool, { today });
  let id = null, speaking = Promise.resolve(), closed = false, busy = false;
  const transcript = [];
  let recognizer, sttOk = true;
  try { recognizer = stt(RATE); }
  catch (e) {
    // No speech-to-text (e.g. no API key): say so and hang up rather than crash the server.
    sttOk = false;
    log(`stt unavailable: ${e.message}`);
    const noop = new EventEmitter(); noop.send = () => {}; noop.close = () => {};
    recognizer = noop;
    queueMicrotask(async () => {
      await play("Sorry, the Deadline Line isn't fully set up yet. Please try again later. Goodbye.");
      await speaking; if (!closed) { sock.write(frame(T.HANGUP)); end(); }
    });
  }

  const play = (text) => {
    transcript.push({ who: "line", text });
    speaking = speaking.then(async () => {
      if (closed) return;
      const pcm = await tts(text, RATE);
      for (let i = 0; i < pcm.length && !closed; i += FRAME) {
        sock.write(frame(T.AUDIO, pcm.subarray(i, i + FRAME)));
        await new Promise(r => setTimeout(r, 20));
      }
    }).catch(e => log(`tts error: ${e.message}`));
    return speaking;
  };
  const end = () => {
    if (closed) return; closed = true;
    try { recognizer.close(); } catch {}
    log(`call ${id ?? "?"} ended; ${transcript.length} turns`);
    sock.end();
  };

  recognizer.on("turn", async ({ text, final }) => {
    if (!final || busy || closed) return;
    busy = true;
    transcript.push({ who: "caller", text });
    log(`caller: ${text}`);
    try {
      const r = await dialog.handle(text);
      log(`line: ${r.say}`);
      await play(r.say);
      if (r.done) { await speaking; sock.write(frame(T.HANGUP)); end(); }
    } catch (e) {
      log(`dialog error: ${e.message}`);
      await play("Sorry, something went wrong on my end. Please try again.");
    } finally { busy = false; }
  });
  recognizer.on("error", (e) => log(`stt error: ${e.message}`));

  sock.on("data", frameParser((type, payload) => {
    if (type === T.UUID) { id = payload.toString("hex"); log(`call ${id} connected`); if (sttOk) play(GREETING); }
    else if (type === T.AUDIO) recognizer.send(Buffer.from(payload));
    else if (type === T.HANGUP) end();
    else if (type === T.ERROR) { log("asterisk reported an error"); end(); }
  }));
  sock.on("close", end);
  sock.on("error", () => end());
  return { dialog, transcript };
}

export function startAudioSocketServer({ port = 9092, host = "127.0.0.1", ...deps }) {
  const server = net.createServer((sock) => handleCall(sock, deps));
  return new Promise(r => server.listen(port, host, () => r(server)));
}
