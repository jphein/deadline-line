import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import WebSocket from "ws";
import { AaiStream } from "../src/aai.js";
import { Dialog, GREETING } from "../src/dialog.js";
import { frame, frameParser, T, handleCall } from "../src/audiosocket.js";
import { resample } from "../src/tts.js";
import { createWeb } from "../src/web.js";
import { startMcp, startFakeAai, fakeStt, fakeTts, TODAY } from "./helpers.mjs";

// ---- AssemblyAI client ---------------------------------------------------------------------
test("AssemblyAI client: auth header, params, buffered audio, final turns only", async () => {
  const aai = await startFakeAai();
  const s = new AaiStream({ apiKey: "test-key", sampleRate: 8000, url: aai.url, keyterms: ["Medi-Cal"] });
  s.send(Buffer.alloc(320));                         // sent before Begin: must be buffered, not lost
  await new Promise(r => s.once("open", r));
  s.send(Buffer.alloc(320));
  const turns = [];
  s.on("turn", t => turns.push(t));
  await new Promise(r => setTimeout(r, 50));
  aai.turn("my landlord", { final: false });
  aai.turn("My landlord gave me a three day notice yesterday.");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(aai.state.auth, "test-key");
  assert.match(aai.state.url, /sample_rate=8000/); assert.match(aai.state.url, /encoding=pcm_s16le/); assert.match(aai.state.url, /keyterms_prompt=/);
  assert.equal(aai.state.bytes, 640);
  assert.deepEqual(turns.map(t => t.final), [false, true]);
  s.close(); await new Promise(r => setTimeout(r, 100));
  assert.equal(aai.state.terminated, true);
  await aai.close();
});

test("AssemblyAI client refuses to run against the real endpoint without a key", () => {
  const saved = process.env.ASSEMBLYAI_API_KEY; delete process.env.ASSEMBLYAI_API_KEY;
  try { assert.throws(() => new AaiStream({ sampleRate: 8000, url: "wss://streaming.assemblyai.com/v3/ws" }), /ASSEMBLYAI_API_KEY/); }
  finally { if (saved) process.env.ASSEMBLYAI_API_KEY = saved; }
});

// ---- dialog against the real Deadline Decoder MCP server ------------------------------------
test("dialog: one-shot SSA call, explanation, text offer, goodbye", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    const a = await d.handle("I got a letter from Social Security dated September 13th, they denied my disability again");
    assert.match(a.say, /^Your deadline is Tuesday, November 17, 2026\. That's 52 days from today\./);
    assert.match(a.say, /HA-501/); assert.match(a.say, /explain how I counted\?$/);
    const b = await d.handle("yes please");
    assert.match(b.say, /^Here's how I counted\. Notice dated Sunday, September 13, 2026\./);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(b.say), "no ISO dates spoken");
    const c = await d.handle("no thanks");
    assert.equal(c.done, true); assert.match(c.say, /not legal advice/);
  } finally { await mcp.close(); }
});

test("dialog: letter first, then the date", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    const a = await d.handle("I got eviction papers");
    assert.match(a.say, /What date is on it\?/);
    const b = await d.handle("the 22nd of September");
    assert.match(b.say, /Your deadline is Wednesday, October 7, 2026/);
  } finally { await mcp.close(); }
});

test("dialog: something that isn't a date, while waiting for one, re-asks without naming a letter", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    assert.match((await d.handle("I got eviction papers.")).say, /^Got it: .*unlawful detainer.*What date is on it\?/);
    const r = await d.handle("What do you mean?");
    assert.doesNotMatch(r.say, /null|undefined/);
    assert.match(r.say, /^I still need the date on the letter\. What date is on it\?/);
    assert.match((await d.handle("They were handed to me on the 22nd of September.")).say, /Wednesday, October 7, 2026/);
  } finally { await mcp.close(); }
});

test("dialog: unknown letter asks which kind; repeat works", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    const a = await d.handle("hi, I got some kind of letter and I'm worried");
    assert.match(a.say, /Social Security, a landlord's three day notice/);
    const b = await d.handle("can you repeat that");
    assert.equal(b.say, a.say);
  } finally { await mcp.close(); }
});

// ---- Asterisk AudioSocket bridge -------------------------------------------------------------
test("AudioSocket framing round-trips, including split packets", () => {
  const got = [];
  const feed = frameParser((type, p) => got.push([type, p.length]));
  const bytes = Buffer.concat([frame(T.UUID, Buffer.alloc(16, 1)), frame(T.AUDIO, Buffer.alloc(320)), frame(T.HANGUP)]);
  feed(bytes.subarray(0, 5)); feed(bytes.subarray(5, 200)); feed(bytes.subarray(200));
  assert.deepEqual(got, [[T.UUID, 16], [T.AUDIO, 320], [T.HANGUP, 0]]);
});

test("a phone call end to end: greeting, caller audio to STT, answer spoken, hangup on goodbye", async () => {
  const mcp = await startMcp();
  const stt = fakeStt();
  const server = net.createServer(sock => handleCall(sock, { callTool: mcp.callTool, stt: () => stt, tts: fakeTts, today: TODAY, log: () => {} }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const client = net.connect(server.address().port, "127.0.0.1");
  const frames = [];
  client.on("data", frameParser((type, p) => frames.push({ type, len: p.length })));
  await new Promise(r => client.once("connect", r));
  try {
    client.write(frame(T.UUID, Buffer.from("0123456789abcdef0123456789abcdef", "hex")));
    for (let i = 0; i < 5; i++) client.write(frame(T.AUDIO, Buffer.alloc(320)));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(stt.bytes, 1600, "caller audio forwarded to speech-to-text");
    const greetingFrames = frames.filter(f => f.type === T.AUDIO).length;
    assert.ok(greetingFrames > 0, "greeting played");
    assert.ok(frames.every(f => f.type !== T.AUDIO || f.len <= 320), "20 ms frames");

    stt.emit("turn", { text: "My landlord taped a three day notice on my door yesterday.", final: true });
    await new Promise(r => setTimeout(r, 600));
    assert.ok(frames.filter(f => f.type === T.AUDIO).length > greetingFrames, "answer played");

    stt.emit("turn", { text: "No thanks, goodbye.", final: true });
    await new Promise(r => setTimeout(r, 800));
    assert.ok(frames.some(f => f.type === T.HANGUP), "line hangs up after goodbye");
    assert.equal(stt.closed, true);
  } finally { client.destroy(); await new Promise(r => server.close(r)); await mcp.close(); }
});

test("a call without speech-to-text apologizes and hangs up instead of crashing", async () => {
  const server = net.createServer(sock => handleCall(sock, { callTool: async () => ({}), stt: () => { throw new Error("ASSEMBLYAI_API_KEY is not set"); }, tts: fakeTts, log: () => {} }));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const client = net.connect(server.address().port, "127.0.0.1");
  const types = [];
  client.on("data", frameParser((type) => types.push(type)));
  await new Promise(r => client.once("connect", r));
  client.write(frame(T.UUID, Buffer.alloc(16)));
  await new Promise(r => setTimeout(r, 700));
  assert.ok(types.includes(T.AUDIO) && types.at(-1) === T.HANGUP);
  client.destroy(); await new Promise(r => server.close(r));
});

// ---- web demo --------------------------------------------------------------------------------
test("web: typed fallback over the WebSocket reaches the dialog", async () => {
  const mcp = await startMcp();
  const { app, attach } = createWeb({ callTool: mcp.callTool, stt: () => fakeStt(), tts: fakeTts, today: TODAY });
  const http = app.listen(0, "127.0.0.1"); await new Promise(r => http.once("listening", r)); attach(http);
  const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/listen`);
  const msgs = [];
  ws.on("message", d => msgs.push(JSON.parse(d.toString())));
  await new Promise(r => ws.once("open", r));
  try {
    await new Promise(r => setTimeout(r, 50));
    assert.equal(msgs[0].text, GREETING);
    ws.send(JSON.stringify({ type: "text", text: "The county says my CalFresh is stopping, the notice is dated September 1st" }));
    await new Promise(r => setTimeout(r, 400));
    const ans = msgs.find(m => m.type === "line" && /deadline/.test(m.text));
    assert.match(ans.text, /Monday, November 30, 2026/);
    const wav = await fetch(`http://127.0.0.1:${http.address().port}/tts?text=hello`);
    assert.equal(wav.headers.get("content-type"), "audio/wav");
  } finally { ws.close(); await new Promise(r => http.close(r)); await mcp.close(); }
});

test("resample 22.05 kHz to 8 kHz keeps duration", () => {
  const one = Buffer.alloc(22050 * 2);
  assert.equal(resample(one, 22050, 8000).length, 8000 * 2);
});
