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
  for (let i = 0; i < 5; i++) s.send(Buffer.alloc(320));   // 20 ms frames sent before Begin: buffered, not lost
  await new Promise(r => s.once("open", r));
  for (let i = 0; i < 5; i++) s.send(Buffer.alloc(320));
  const turns = [];
  s.on("turn", t => turns.push(t));
  await new Promise(r => setTimeout(r, 50));
  aai.turn("my landlord", { final: false });
  aai.turn("My landlord gave me a three day notice yesterday.");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(aai.state.auth, "test-key");
  assert.match(aai.state.url, /sample_rate=8000/); assert.match(aai.state.url, /encoding=pcm_s16le/); assert.match(aai.state.url, /keyterms_prompt=/);
  // the 5 frames held until Begin go out as one 100 ms message, then every 3 frames as 60 ms; 40 ms waits
  assert.deepEqual(aai.state.chunksMs, [100, 60]);
  assert.equal(aai.state.violations, 0);
  assert.deepEqual(turns.map(t => t.final), [false, true]);
  s.close(); await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(aai.state.chunksMs, [100, 60, 50]); // the 40 ms rest, padded to 50 ms, before Terminate
  assert.equal(aai.state.bytes, 3360);                  // all 3200 bytes of audio, plus 160 bytes of padding
  assert.equal(aai.state.terminated, true);
  await aai.close();
});

test("AssemblyAI client: 20 ms phone frames go out as 50 to 1000 ms messages", async () => {
  const aai = await startFakeAai();
  const s = new AaiStream({ apiKey: "test-key", sampleRate: 8000, url: aai.url });
  await new Promise(r => s.once("open", r));
  const errors = []; s.on("error", e => errors.push(e.message));
  for (let i = 0; i < 50; i++) s.send(Buffer.alloc(320));   // one second of AudioSocket frames
  await new Promise(r => setTimeout(r, 50));
  s.close(); await new Promise(r => setTimeout(r, 100));
  assert.equal(aai.state.violations, 0, `chunk lengths (ms): ${aai.state.chunksMs.join(", ")}`);
  assert.ok(aai.state.chunksMs.every(ms => ms >= 50 && ms <= 1000));
  assert.ok(aai.state.bytes >= 16000);                  // nothing lost: 1 s of audio, plus any padding at close
  assert.deepEqual(errors, []);
  assert.equal(aai.state.terminated, true);
  await aai.close();
});

test("AssemblyAI client: a long burst is split into 1000 ms pieces", async () => {
  const aai = await startFakeAai();
  const s = new AaiStream({ apiKey: "test-key", sampleRate: 16000, url: aai.url });
  await new Promise(r => s.once("open", r));
  s.send(Buffer.alloc(80000));                          // 2.5 s at 16 kHz in one message
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(aai.state.chunksMs, [1000, 1000, 500]);
  assert.equal(aai.state.violations, 0);
  s.close(); await new Promise(r => setTimeout(r, 100));
  await aai.close();
});

test("AssemblyAI client: the last scrap of audio is padded to 50 ms at close", async () => {
  const aai = await startFakeAai();
  const s = new AaiStream({ apiKey: "test-key", sampleRate: 8000, url: aai.url });
  await new Promise(r => s.once("open", r));
  s.send(Buffer.alloc(480));                            // 30 ms: too short to send on its own
  await new Promise(r => setTimeout(r, 50));
  assert.equal(aai.state.bytes, 0);                     // held back
  s.close(); await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(aai.state.chunksMs, [50]);           // padded with silence, sent before Terminate
  assert.equal(aai.state.violations, 0);
  assert.equal(aai.state.terminated, true);
  await aai.close();
});

test("AssemblyAI client refuses a missing sample rate", () => {
  assert.throws(() => new AaiStream({ apiKey: "test-key", url: "ws://127.0.0.1:9/v3/ws" }), /sampleRate/);
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
    assert.match(a.say, /^I couldn't tell which kind of letter that is\. Is it about Social Security, your rent or your home, a court case or jury duty, a traffic or parking ticket, or the DMV, a shutoff notice, a debt collector or a repossessed car, unemployment benefits, taxes or the IRS, or Medi-Cal, CalFresh or CalWORKs\? And what date is on it\?$/);
    const b = await d.handle("can you repeat that");
    assert.equal(b.say, a.say);
  } finally { await mcp.close(); }
});

test("dialog: a jury summons has nothing to count, so it answers at once and offers another letter", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    const a = await d.handle("I got a jury summons in the mail");
    assert.match(a.say, /^A jury summons prints its own date to respond or to report, and that's the date that counts\. Respond to the court by the date on the summons\. First step: /);
    assert.match(a.say, /Do you have another letter I can help with\?$/);
    assert.doesNotMatch(a.say, /explain how I counted/);
    assert.equal((await d.handle("yes")).say, "Okay. Tell me what kind of letter it is, and the date on it.");
    const b = await d.handle("I got a letter from Social Security dated September 13th, they denied my disability again");
    assert.match(b.say, /^Your deadline is Tuesday, November 17, 2026\./);
  } finally { await mcp.close(); }
});

test("dialog: a bare summons becomes a question, and the answer picks among its candidates", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    assert.equal((await d.handle("I got a summons")).say, "Is it about an eviction, a lawsuit about money, or jury duty?");
    const a = await d.handle("a debt collector, about money I owe");
    assert.equal(a.say, "Got it: California: court papers for a lawsuit (a Summons that isn't about an eviction). What day were the papers handed to you? You can say something like September 13th.");
    const b = await d.handle("September 21st");                       // Mon Sep 21 + 30 = Wed Oct 21
    assert.match(b.say, /^Your deadline is Wednesday, October 21, 2026\. That's 25 days from today\. File a written response with the court\./);
    const c = await d.handle("how did you count?");
    assert.match(c.say, /^Here's how I counted\. Served Monday, September 21, 2026\. The day you are served does not count\. 30 days from the day you were served: Wednesday, October 21, 2026\./);
    assert.equal((await d.handle("no thanks")).done, true);
  } finally { await mcp.close(); }
});

test("dialog: a jury summons ends the call when there's nothing else", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    await d.handle("I have jury duty");
    const r = await d.handle("no");
    assert.equal(r.done, true); assert.match(r.say, /not legal advice/);
  } finally { await mcp.close(); }
});

test("dialog: a bare IRS letter asks which one; a levy notice gets its hearing date", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    assert.equal((await d.handle("I got a letter from the IRS")).say, "Is it a CP2000 about proposed changes to your return, a Notice of Deficiency, or a final notice before a levy?");
    assert.match((await d.handle("a final notice before a levy")).say, /^Got it: IRS: a final notice of intent to levy \(and your right to a hearing\)\. What date is on it\?/);
    const a = await d.handle("September 15th");                          // Sep 15 + 30 = Thu Oct 15
    assert.match(a.say, /^Your deadline is Thursday, October 15, 2026\. That's 19 days from today\. Ask for a Collection Due Process hearing\./);
  } finally { await mcp.close(); }
});

test("dialog: a rent increase leads with the earliest date and adds the 90-day one", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    const a = await d.handle("my landlord says my rent is going up, the notice was handed to me on September 15th");
    assert.match(a.say, /^If the increase is 10 percent or less, the new rent can't start before Thursday, October 15, 2026, 19 days from today\. Keep paying your current rent until the new rent can start\. If it's more than 10 percent, it can't start before Monday, December 14, 2026, 90 days after you got the notice\. First step: /);
  } finally { await mcp.close(); }
});

test("dialog: an overpayment says the appeal date and the 30-day date", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: TODAY });
    const a = await d.handle("Social Security says they overpaid me, the letter is dated September 13th");
    assert.match(a.say, /^Your deadline is Tuesday, November 17, 2026\. That's 52 days from today\. Appeal it if it's wrong, or ask for a waiver\. For Social Security benefits \(not SSI\), ask by Tuesday, October 13, 2026, 30 days after the date on the notice, and they won't start taking money back while they decide\. First step: /);
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

test("dialog: the help line reads as a sentence, and a date said as an event isn't the letter's date", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    const a = await d.handle("I got a jury summons, I have to report October 1st");
    assert.match(a.say, / For questions, call your court's jury office: the phone number and website are printed on your summons\. Do you have another letter/);
    assert.doesNotMatch(a.say, /For free help, Your|2025/);
    assert.equal(d.date, null);
    d.reset();
    const b = await d.handle("I got a rent increase notice and my rent goes up November 1st");
    assert.match(b.say, /^Got it: California: a notice that your rent is going up\. What day was the notice handed to you\?/);   // it asks for the notice's date instead of using November 1st
    const c = await d.handle("I got it yesterday");                    // Tue Sep 29 + 30 = Thu Oct 29
    assert.match(c.say, /October 29, 2026/);
    assert.match(c.say, / For free help: Legal Services of Northern California, free civil legal aid, lsnc\.net or call your local office\. /);
  } finally { await mcp.close(); }
});

test("dialog: a date answer is read the way the known letter's date is (a shutoff counted from the bill's due date)", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    const q = await d.handle("they're turning off my water");
    assert.match(q.say, /^Got it: California: a notice that your water will be shut off for an unpaid bill\. When was the unpaid water bill due\?/);
    const a = await d.handle("the due date was August 1st");                      // Aug 1 + 60 = Wed Sep 30
    assert.match(a.say, /^Most water systems can't shut off your water before Wednesday, September 30, 2026/);
    assert.equal(d.date, "2026-08-01");
  } finally { await mcp.close(); }
});

test("dialog: a Social Security denial that mentions a hearing asks whether the hearing has happened", async () => {
  const mcp = await startMcp();
  try {
    for (const [answer, letter] of [["not yet", "ssa-recon"], ["yes, I already had it", "ssa-appeals-council"]]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      const q = await d.handle("social security denied me again and my hearing is scheduled");
      assert.equal(q.say, "Have you already had your Social Security hearing with a judge?");
      const a = await d.handle(answer);
      assert.equal(d.letter, letter, answer);
      assert.match(a.say, /^Got it: Social Security/, answer);
    }
    // "I don't know" asks again.
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await d.handle("social security denied me again and my hearing is scheduled");
    assert.equal((await d.handle("I don't know")).say, "Have you already had your Social Security hearing with a judge?");
  } finally { await mcp.close(); }
});

test("dialog: a request to repeat still repeats; 'denied me again' is heard as words", async () => {
  const mcp = await startMcp();
  try {
    for (const ask of ["say that again", "can you repeat that", "pardon?", "come again?", "again", "one more time please", "what was that",
      "say again", "tell me again", "can you tell me that again", "read it again", "go over that again", "again, please", "what did you say",
      "sorry, what?", "huh?", "what?", "will you say that again", "can you tell me my deadline again", "go over my options again", "sorry?"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      const first = await d.handle("I got a jury summons in the mail");
      assert.equal((await d.handle(ask)).say, first.say, ask);
    }
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    const jury = await d.handle("I got a jury summons in the mail");
    assert.notEqual((await d.handle("yes, and social security denied me again")).say, jury.say);   // heard, not replayed
    const e = new Dialog(mcp.callTool, { today: "2026-09-30" });
    assert.doesNotMatch((await e.handle("social security denied my disability again")).say, /^Deadline Line\./);
    // Words that sound like it but aren't a request: a denial again, "they said no again", "what" inside a sentence.
    for (const x of ["they said no again", "social security turned me down again", "what do I do about my eviction papers",
      "they say I owe again, social security overpaid me", "I read the letter again and it says I have 30 days", "they say it again and again",
      "they say no again", "they read my file again and denied it", "the judge will tell me again at the hearing"]) {
      const f = new Dialog(mcp.callTool, { today: "2026-09-30" });
      assert.doesNotMatch((await f.handle(x)).say, /^Deadline Line\./, x);
    }
  } finally { await mcp.close(); }
});

test("dialog: 'I read it again and it says September 28th' is a date answer, not a request to repeat", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await d.handle("I got a 3 day notice");
    const a = await d.handle("I read it again and it says September 28th");
    assert.equal(d.date, "2026-09-28");
    assert.doesNotMatch(a.say, /^Got it: California: a 3-day notice/);
    const e = new Dialog(mcp.callTool, { today: "2026-09-30" });
    assert.equal((await e.handle("they say I owe again, social security overpaid me")).say.startsWith("Deadline Line."), false);
    assert.equal(e.letter, "ssa-overpayment");
  } finally { await mcp.close(); }
});

test("dialog: a caller who says HOA hears the § 5715 redemption right; a plain deed-of-trust caller doesn't", async () => {
  const mcp = await startMcp();
  try {
    const say = async (x) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); const a = await d.handle(x); return [d, a]; };
    const STEP = "If your homeowners association is foreclosing without going to court over assessments that came due from 2006 on, you may still be able to redeem the home for 90 days after the sale, and the notice of sale is supposed to mention that right. Ask legal aid right away.";
    for (const [x, id] of [["my HOA sent a notice of default", "ca-foreclosure-nod"], ["the HOA is auctioning my condo for unpaid assessments", "ca-foreclosure-sale"],
      ["my homeowners association sent a notice of trustee's sale", "ca-foreclosure-sale"]]) {
      const [d, a] = await say(x);
      assert.equal(d.letter, id, x);
      assert.ok(a.say.includes(` ${STEP} `), x);
      assert.equal(a.say.split(STEP).length, 2, `${x}: said once`);
      assert.ok(d.result.next_steps.includes(STEP), `${x}: the engine's own step`);
    }
    // Two turns: the HOA is named first, the notice on the next turn (the flag rides in the state).
    const two = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await two.handle("my HOA sent me a letter");
    const second = await two.handle("a notice of default");
    assert.equal(two.letter, "ca-foreclosure-nod");
    assert.equal(second.say.split(STEP).length, 2, "two turns: said once");
    assert.equal(two.snapshot().hoa, false, "cleared once said");
    // Two letters in one call, the first answered: the HOA mention was used up there, so the second has no HOA text.
    const both = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await both.handle("my HOA is suing me in small claims");
    await both.handle("yes");
    assert.ok(!(await both.handle("I got a notice of default on my house")).say.includes("homeowners association"), "after another answered letter");
    // A corrected letter from the same sender (no new sender named) is still the HOA's: the step, once.
    for (const [first, fix] of [["my HOA sent me a rent increase notice", "no, it's a notice of default on my house"],
      ["my HOA gave me a 3 day notice", "actually it's a notice of default"]]) {
      const sw = new Dialog(mcp.callTool, { today: "2026-09-30" });
      await sw.handle(first);
      assert.equal(((await sw.handle(fix)).say.match(/If your homeowners association is foreclosing/g) || []).length, 1, first);
    }
    for (const x of ["I got a notice of default on my house", "I got a notice of trustee's sale"]) {
      const [, a] = await say(x);
      assert.ok(!a.say.includes("homeowners association"), x);
    }
  } finally { await mcp.close(); }
});

test("dialog: 'I got a UD.' (as speech ends, with a period) is heard as eviction papers", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    const a = await d.handle("I got a UD.");
    assert.equal(d.letter, "ca-ud");
    assert.match(a.say, /^Got it: California: court papers for an eviction \(Summons, unlawful detainer\)\./);
  } finally { await mcp.close(); }
});

test("dialog: the HOA step only for an HOA by name, not a lender's notice, and once when the HOA is named after the answer", async () => {
  const mcp = await startMcp();
  try {
    const run = async (turns) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); let a; for (const t of turns) a = await d.handle(t); return [d, a]; };
    const times = (a) => (a.say.match(/If your homeowners association is foreclosing/g) || []).length;
    // Not every "association" is an HOA.
    for (const x of ["the bar association lawyer said my notice of default is real", "I got a notice of default, the neighborhood association meeting is tonight",
      "the credit union association sent a notice of default on my house"]) { const [d, a] = await run([x]); assert.equal(d.letter, "ca-foreclosure-nod", x); assert.equal(times(a), 0, x); }
    // A condo association, and the ways ASR spells HOA.
    for (const x of ["my condo association sent a notice of default", "the H.O.A. sent a notice of default", "the h.o.a. sent a notice of default",
      "the H O A sent a notice of default"]) {
      const [, a] = await run([x]); assert.equal(times(a), 1, x);
    }
    // The spaced form only in capitals: lowercase "ho a" is ordinary speech to ASR.
    for (const x of ["I got a notice of default, is there a ho a hearing", "the h o a sent a notice of default"]) {
      const [d, a] = await run([x]); assert.equal(d.letter, "ca-foreclosure-nod", x); assert.equal(times(a), 0, x);
    }
    // The HOA named first, then the notice turns out to be the lender's: no step.
    const [, lender] = await run(["my HOA sent me a letter", "actually it's from my mortgage lender, a notice of default"]);
    assert.equal(times(lender), 0);
    // The notice answered first, then "it's from my HOA": the step, once, and the line asks for the next letter.
    const [after, hoa] = await run(["I got a notice of default on my house", "it's from my HOA"]);
    assert.equal(times(hoa), 1);
    assert.match(hoa.say, /Do you have another letter I can help with\?$/);
    assert.equal(after.letter, "ca-foreclosure-nod");
  } finally { await mcp.close(); }
});

test("dialog: restore() takes the HOA flag only as a real true (a tampered snapshot doesn't bring the step)", async () => {
  const mcp = await startMcp();
  try {
    const times = (a) => (a.say.match(/If your homeowners association is foreclosing/g) || []).length;
    for (const [hoa, want] of [["yes", 0], [1, 0], [{}, 0], ["true", 0], [true, 1]]) {
      const d = await Dialog.restore(mcp.callTool, { letter: null, awaiting: "letter", hoa }, { today: "2026-09-30" });
      assert.equal(times(await d.handle("a notice of default")), want, JSON.stringify(hoa));
    }
  } finally { await mcp.close(); }
});
