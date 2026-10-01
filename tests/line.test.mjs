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
    // "Hoa" is a given name, not an HOA; the acronym is.
    for (const x of ["my friend Hoa helped me read the notice of default on my house", "Hoa is my name, I got a notice of default",
      "my friend Hoa sent me a photo of my notice of default",
      // Opening the sentence, but not sending the notice itself: the name.
      "Hoa sent me a text about the notice of default on my house", "Hoa gave me a ride to court, I got a notice of default",
      "Hoa mailed me a copy of my notice of default", "Hoa filed my papers, I have a notice of default on my house",
      "Hoa sent me my bank's notice of default", "Hoa sent me a photo of the notice of default, she's my sister",
      "Hoa sent me my notice of default from the mailbox",
      // A lender in the same turn: the title-cased "Hoa" may be a name.
      "Hoa sent me a letter about my bank's notice of default", "Hoa sent me a notice of default from my mortgage lender",
      "Hoa sent me a letter about the bank notice of default"]) {
      const [d, a] = await run([x]); assert.equal(d.letter, "ca-foreclosure-nod", x); assert.equal(times(a), 0, x);
    }
    for (const x of ["my HOA sent a notice of default", "my hoa sent a notice of default",
      // ASR's own output for a spoken "hoa" opening the sentence (measured, AssemblyAI streaming).
      "Hoa sent me the Notice of Default.", "I got a notice of default. Hoa is foreclosing on my condo.",
      "Hoa mailed a notice of default to my house", "Hoa sent us a notice of trustee's sale",
      // A real HOA still wins over a lender in the same turn.
      "my HOA and my bank both sent a notice of default",
      // A lender only mentioned, not the sender, doesn't beat it; nothing beats "Hoa is foreclosing".
      "Hoa sent me the Notice of Default. My mortgage is fine.", "Hoa is foreclosing on my condo, my bank says it's behind them"]) { const [, a] = await run([x]); assert.equal(times(a), 1, x); }
    // Said once per letter: a repeated "it's from my HOA", or one after the step was already in the answer.
    const said = async (turns) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); let n = 0; for (const t of turns) n += times(await d.handle(t)); return n; };
    assert.equal(await said(["I got a notice of default on my house", "it's from my HOA", "it's from my HOA"]), 1);
    assert.equal(await said(["my HOA sent a notice of default", "it's from my HOA"]), 1);
    // A finished conversation (the goodbye, or the text-me close) doesn't carry its HOA mention, or its step, into the next.
    const replies = async (turns) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); const out = []; for (const t of turns) out.push(await d.handle(t)); return out; };
    const done = await replies(["my HOA sent a notice of default", "no", "I got a notice of default on my house", "it's from my HOA"]);
    assert.equal(done[1].done, true);
    assert.deepEqual(done.map(times), [1, 0, 0, 1]);
    assert.doesNotMatch(done[3].say, /I've included/);
    assert.deepEqual((await replies(["my HOA sent me a letter", "goodbye", "I got a notice of default on my house"])).map(times), [0, 0, 0]);
    // A new letter gets its own step.
    assert.equal(await said(["my HOA sent a notice of default", "yes", "my HOA sent a notice of trustee's sale"]), 2);
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

test("dialog: small claims papers from a debt collector get the small-claims answer, not the validation notice's", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    const a = await d.handle("I got small claims papers from a debt collector");
    assert.equal(d.letter, "ca-small-claims");
    assert.match(a.say, /small claims/i);
    assert.doesNotMatch(a.say, /validation notice/i);
  } finally { await mcp.close(); }
});

test("dialog: a validation notice with the CFPB complaint line gets the validation answer", async () => {
  const mcp = await startMcp();
  try {
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    const a = await d.handle("Example Collections LLC is a debt collector. We are trying to collect a debt that you owe to Example Bank. " +
      "How can you dispute the debt? Call or write to us by October 30, 2026, to dispute all or part of the debt. " +
      "If you have a complaint about how we are collecting this debt, contact the CFPB at www.consumerfinance.gov or call 1-855-411-2372.");
    assert.equal(d.letter, "debt-validation");
    assert.doesNotMatch(a.say, /summons|court papers/i);
  } finally { await mcp.close(); }
});

test("dialog: a validation notice's 'If you receive a summons' line gets the validation answer; a real summons still gets the summons answer", async () => {
  const mcp = await startMcp();
  try {
    const notice = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await notice.handle("Example Collections LLC is a debt collector. We are trying to collect a debt that you owe to Example Bank. " +
      "Call or write to us by October 30, 2026, to dispute all or part of the debt. If you receive a summons, do not ignore it.");
    assert.equal(notice.letter, "debt-validation");
    const summons = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await summons.handle("a debt collector sued me and I got a summons");
    assert.equal(summons.letter, "ca-civil-summons");
  } finally { await mcp.close(); }
});

test("dialog: 'may have been served already' is asked about: court papers get the summons answer, a letter the validation answer", async () => {
  const mcp = await startMcp();
  try {
    for (const [answer, want] of [["court papers", "ca-civil-summons"], ["a letter", "debt-validation"]]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      const q = await d.handle("The debt collector says you may have been served already with a lawsuit.");
      assert.equal(q.say, "Did you get court papers about a lawsuit, like a summons, or a letter from the debt collector?");
      assert.equal(d.letter, null);
      await d.handle(answer);
      assert.equal(d.letter, want, answer);
    }
  } finally { await mcp.close(); }
});

test("dialog: the served-already ask hears 'no summons' as the letter, 'both' as the summons, and asks again on a bare 'no'; served eviction papers get the eviction answer", async () => {
  const mcp = await startMcp();
  try {
    const Q = "Did you get court papers about a lawsuit, like a summons, or a letter from the debt collector?";
    for (const [answer, want] of [["no summons", "debt-validation"], ["both", "ca-civil-summons"], ["no", null]]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      assert.equal((await d.handle("The debt collector says you may have been served already with a lawsuit.")).say, Q);
      const a = await d.handle(answer);
      assert.equal(d.letter, want, answer);
      if (want === null) assert.equal(a.say, Q, "asked again");
    }
    const ud = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await ud.handle("my landlord served me with papers for an eviction");
    assert.equal(ud.letter, "ca-ud");
  } finally { await mcp.close(); }
});

test("dialog: papers served with a 3-day notice are asked about; a lawsuit from a collector is asked about; 'the letter says they sued me' is asked again", async () => {
  const mcp = await startMcp();
  try {
    const PAPERS = "Did you get court papers about a lawsuit, like a summons, or a letter from the debt collector?";
    const notice = new Dialog(mcp.callTool, { today: "2026-09-30" });
    assert.equal((await notice.handle("a debt collector served me with papers about a 3 day notice")).say, "Is it about an eviction, a lawsuit about money, or jury duty?");
    assert.equal(notice.letter, null);
    await notice.handle("an eviction");
    assert.equal(notice.letter, "ca-ud");
    const lawsuit = new Dialog(mcp.callTool, { today: "2026-09-30" });
    assert.equal((await lawsuit.handle("the lawsuit from the collection agency")).say, PAPERS);
    assert.equal(lawsuit.letter, null);
    const again = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await again.handle("The debt collector says you may have been served already with a lawsuit.");
    assert.equal((await again.handle("the letter says they sued me")).say, PAPERS);
    assert.equal(again.letter, null);
  } finally { await mcp.close(); }
});

test("dialog: a second letter named in the same turn is spoken and taken up next, even after 'explain how I counted'", async () => {
  const mcp = await startMcp();
  try {
    const run = async (turns) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); const out = []; for (const t of turns) out.push({ ...(await d.handle(t)), letter: d.letter, awaiting: d.awaiting }); return out; };
    const ALSO = /You also mentioned court papers for a lawsuit; tell me about that next\. Want me to explain how I counted\?$/;
    // The 3-day answer (it has counting steps), then "yes" explains, then the text offer, then the carried summons.
    for (const [textReply, lead] of [["yes", /^Okay\. In the real service I'd text the date/], ["no", /^Okay\. Now, about court papers/]]) {
      const r = await run(["the collection agency is suing me, I also got a 3 day notice", "September 28", "yes", textReply, "September 25"]);
      assert.equal(r[1].letter, "ca-3day"); assert.match(r[1].say, ALSO);
      assert.match(r[2].say, /^Here's how I counted\..*Would you like me to text you the date\?$/s);
      assert.match(r[3].say, lead); assert.match(r[3].say, /Now, about court papers for a lawsuit\. What date is on it\?/);
      assert.equal(r[3].done, false); assert.equal(r[3].letter, "ca-civil-summons"); assert.equal(r[3].awaiting, "date");
      assert.equal(r[4].letter, "ca-civil-summons"); assert.match(r[4].say, /^Your deadline is Monday, October 26, 2026\./);
    }
    // "no" to the explanation: straight to the carried letter.
    const skip = await run(["the collection agency is suing me, I also got a 3 day notice", "September 28", "no"]);
    assert.match(skip[2].say, /^Okay\. Now, about court papers for a lawsuit/); assert.equal(skip[2].done, false);
    // "the summons" while the 3-day answer is open: the summons question, not the 3-day answer again.
    const summons = await run(["the collection agency is suing me, I also got a 3 day notice", "September 28", "the summons", "a lawsuit about money", "September 25"]);
    assert.equal(summons[2].say, "Is it about an eviction, a lawsuit about money, or jury duty?"); assert.equal(summons[2].letter, null);
    assert.equal(summons[3].letter, "ca-civil-summons"); assert.match(summons[4].say, /^Your deadline is Monday, October 26, 2026\./);
    // The sooner deadline first (the 3-day notice), the summons carried; the caller then describes it.
    const other = await run(["I got a 3 day notice and also a summons from a debt collector", "September 28", "no", "it's the summons from the debt collector, I got it September 25"]);
    assert.equal(other[1].letter, "ca-3day"); assert.match(other[1].say, /You also mentioned court papers for a lawsuit; tell me about that next\./);
    assert.match(other[2].say, /^Okay\. Now, about court papers for a lawsuit/);
    assert.equal(other[3].letter, "ca-civil-summons"); assert.match(other[3].say, /^Your deadline is Monday, October 26, 2026\./);
    // A first answer with nothing to count asks the carried letter's date at once; a goodbye still ends the call.
    const jury = await run(["I got a jury summons, I also got a 60 day notice to move out", "September 1"]);
    assert.match(jury[0].say, /You also mentioned a 60-day notice to move out; tell me about that next\. What date is on it\?$/);
    assert.equal(jury[1].letter, "ca-60day-notice");
    const bye = await run(["I got a jury summons, I also got a 60 day notice to move out", "goodbye"]);
    assert.equal(bye[1].done, true);
    // A carried letter with no date to ask for, after a first answer with nothing to count: offered, not asked a date.
    const go = await run(["I got a jury summons, plus a notice of default", "yes"]);
    assert.match(go[0].say, /tell me about that next\. Want me to go on to it\?$/); assert.doesNotMatch(go[0].say, /What date is on it/);
    assert.equal(go[1].letter, "ca-foreclosure-nod"); assert.match(go[1].say, /^A Notice of Default starts the foreclosure clock/);
    assert.doesNotMatch(go[1].say, /What date is on it|What day/);   // "yes" answers it, no date asked
    const stop = await run(["I got a jury summons, plus a notice of default", "no"]);
    assert.equal(stop[1].done, true);
    // No "act by" date for a letter with no date to count from (a Notice of Default's printed date is already past, a
    // sale's is too late): don't put it off.
    const END = "This is general information, not legal advice. Goodbye.";
    assert.equal(stop[1].say, `Okay. Don't put off dealing with the Notice of Default. Call back if you'd like to go over it, or look for free legal help. ${END}`);
    const declined = async (id) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); Object.assign(d, { letter: "jury-summons", awaiting: "another", carry: [id] }); return (await d.handle("no")).say; };
    // The trustee's sale only: reinstatement ends five business days before the sale date (Civ. Code § 2924c(e)).
    assert.equal(await declined("ca-foreclosure-sale"), `Okay. Don't put off dealing with the Notice of Trustee's Sale. If you want to catch up on the loan, the cutoff is generally five business days before the sale date, not the sale date itself. Call back if you'd like to go over it, or look for free legal help. ${END}`);
    assert.equal(await declined("ca-small-claims"), `Okay. Don't put off dealing with the small claims court papers. Call back if you'd like to go over it, or look for free legal help. ${END}`);
    // A carried question: with nothing to count first, it's asked at once; after a counted answer, where the carried
    // letter would come in; "no" twice at the date question goes on to it too.
    const asked = await run(["I got a notice of default on my house, I also got a summons", "a lawsuit about money", "September 25"]);
    assert.match(asked[0].say, /You also mentioned a summons or court papers; tell me about that next\. Is it about an eviction, a lawsuit about money, or jury duty\?$/);
    assert.equal(asked[0].letter, null); assert.equal(asked[1].letter, "ca-civil-summons"); assert.match(asked[2].say, /^Your deadline is Monday, October 26, 2026\./);
    const later = await run(["I got a 3 day notice, I also got a summons", "September 28", "no", "a lawsuit about money"]);
    assert.match(later[1].say, /You also mentioned a summons or court papers; tell me about that next\. Want me to explain how I counted\?$/);
    assert.equal(later[2].say, "Okay. Is it about an eviction, a lawsuit about money, or jury duty?"); assert.equal(later[3].letter, "ca-civil-summons");
    const irs = await run(["I got a 3 day notice, plus a letter from the IRS", "no", "no"]);
    assert.equal(irs[2].say, "Okay. Is it a CP2000 about proposed changes to your return, a Notice of Deficiency, or a final notice before a levy?");
    // A carried letter with no date to ask for is answered when it's reached.
    const nod = await run(["social security denied my disability, I also got a notice of default", "September 20", "yes", "no"]);
    assert.match(nod[1].say, /You also mentioned a Notice of Default; tell me about that next\./);
    assert.equal(nod[3].letter, "ca-foreclosure-nod"); assert.match(nod[3].say, /^Okay\. A Notice of Default starts the foreclosure clock/);
  } finally { await mcp.close(); }
});

test("dialog: 'no' twice to the date question offers to stop, or goes on to a letter the caller also named", async () => {
  const mcp = await startMcp();
  try {
    const run = async (turns) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); const out = []; for (const t of turns) out.push({ ...(await d.handle(t)), letter: d.letter, awaiting: d.awaiting }); return out; };
    const stop = await run(["I got a 3 day notice", "no", "no", "yes"]);
    assert.match(stop[1].say, /^I still need the date on the letter\./);
    assert.equal(stop[2].say, "If you find the date, call back right away: some of these run out in days. Do you want to stop here?");
    assert.equal(stop[3].done, true);
    const keep = await run(["I got a 3 day notice", "no", "no", "no", "September 28"]);
    assert.match(keep[3].say, /^Okay\. What date is on it\?/); assert.equal(keep[4].letter, "ca-3day"); assert.match(keep[4].say, /^Your deadline is/);
    const onward = await run(["the collection agency is suing me, I also got a 3 day notice", "no", "no"]);
    assert.match(onward[2].say, /^Okay\. Now, about court papers for a lawsuit/); assert.equal(onward[2].letter, "ca-civil-summons");
    // At "Do you want to stop here?": a letter named in the reply is taken up, not a goodbye; a bare "yes" or "bye" ends
    // the call; a bare "no" (don't stop) asks for the date again, in the letter's own words.
    const atStop = async (reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of ["I got a 30 day notice", "no", "no"]) await d.handle(t); return { ...(await d.handle(reply)), letter: d.letter }; };
    const taken = await atStop("yes, I also got a 3 day notice");
    assert.equal(taken.done, false); assert.equal(taken.letter, "ca-3day"); assert.match(taken.say, /^Got it: California: a 3-day notice to pay rent or move out\. What date is on it\?/);
    assert.equal((await atStop("yeah, there's a summons too")).say, "Is it about an eviction, a lawsuit about money, or jury duty?");
    for (const reply of ["yes", "bye"]) assert.equal((await atStop(reply)).done, true, reply);
    // The review's phrasings, at the 30-day notice's stop offer: the letter named is taken up, whatever word leads.
    const ud = await atStop("yes, but I also got an eviction summons");
    assert.equal(ud.letter, "ca-ud"); assert.match(ud.say, /^Got it: California: court papers for an eviction .*What date is on it\?/);
    const jury = await atStop("bye, actually I have a jury summons");
    assert.equal(jury.done, false); assert.equal(jury.letter, "jury-summons"); assert.match(jury.say, /^A jury summons prints its own date/);
    // A notice of default has no date to ask for: it's answered.
    const nod = await atStop("no, I got a notice of default");
    assert.equal(nod.letter, "ca-foreclosure-nod"); assert.match(nod.say, /^A Notice of Default starts the foreclosure clock/);
    assert.match((await atStop("no")).say, /^Okay\. What day was the notice handed to you\?/);
    // One "no", then the date: no stop offer.
    const once = await run(["I got a 3 day notice", "no", "September 28"]);
    assert.match(once[2].say, /^Your deadline is/);
    // The once-said "no" lasts one turn: a goodbye, or another letter, clears it (a later "no" starts over).
    const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await d.handle("I got a 3 day notice"); await d.handle("no"); assert.equal(d.dateNo, true);
    await d.handle("actually it's a 30 day notice"); assert.equal(d.dateNo, false);
    assert.match((await d.handle("no")).say, /^I still need the date on the letter\./);
    const bye = new Dialog(mcp.callTool, { today: "2026-09-30" });
    await bye.handle("I got a 3 day notice"); await bye.handle("no"); await bye.handle("goodbye"); assert.equal(bye.dateNo, false);
  } finally { await mcp.close(); }
});

test("dialog: every letter is named well when it's carried ('Now, about …', 'You also mentioned …')", async () => {
  const mcp = await startMcp();
  try {
    const types = (await mcp.callTool("list_letter_types", {})).letter_types;
    assert.equal(types.length, 37);
    for (const { id, needs_date, carry_title } of types) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      d.carry = [id];
      const line = await d.carryLine();
      assert.equal(line, `You also mentioned ${carry_title}; tell me about that next.`, id);
      assert.doesNotMatch(line, /\bmy\b|California:|[()]/, id);
      if (needs_date) assert.match((await d.startCarry("")).say, new RegExp(`^Now, about ${carry_title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. What date is on it\\?`), id);
    }
  } finally { await mcp.close(); }
});

test("dialog: a yes, no or goodbye that names a letter is about that letter, at every stage (the decoder decides)", async () => {
  const mcp = await startMcp();
  try {
    const at = async (setup, reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await d.handle(t); return { ...(await d.handle(reply)), letter: d.letter, awaiting: d.awaiting }; };
    const MORE = ["I got a 3 day notice dated September 28"], TEXT = [...MORE, "yes"], STOP = ["I got a 30 day notice", "no", "no"];
    // After a deadline ("explain how I counted?") and at the text offer: not a goodbye, not a dropped letter.
    for (const [setup, reply, letter, say] of [
      [MORE, "no, but I also got an eviction summons", "ca-ud", /^Got it: California: court papers for an eviction/],
      [MORE, "bye, actually I have a jury summons", "jury-summons", /^A jury summons prints its own date/],
      [MORE, "yes, and I also got a parking ticket", "ca-parking-ticket", /^Got it: California: a parking ticket/],
      [MORE, "no, I also got a notice of default", "ca-foreclosure-nod", /^A Notice of Default starts the foreclosure clock/],
      [TEXT, "no, but I also got an eviction summons", "ca-ud", /^Got it: California: court papers for an eviction/],
      [TEXT, "yes, and I also got a parking ticket", "ca-parking-ticket", /^Got it: California: a parking ticket/],
      [TEXT, "bye, actually I have a jury summons", "jury-summons", /^A jury summons prints its own date/],
      // At the stop offer, words outside a fixed list: the decoder hears the letter.
      [STOP, "thanks, I also got an unlawful detainer", "ca-ud", /^Got it: California: court papers for an eviction/],
      [STOP, "yes, and a CP2000 from the IRS", "irs-cp2000", /^Got it: IRS: a CP2000 notice/]]) {
      const r = await at(setup, reply);
      assert.equal(r.done, false, reply); assert.equal(r.letter, letter, reply); assert.match(r.say, say, reply);
    }
    // Documented: what the decoder doesn't recognize isn't a letter. "no, the landlord also sued me" at the stop offer is
    // a "no" (don't stop): the date question again.
    assert.match((await at(STOP, "no, the landlord also sued me")).say, /^Okay\. What day was the notice handed to you\?/);
    // After "it's from my HOA", and in the HOA check itself: a letter outside any word list is still heard.
    for (const [reply, letter] of [["thanks, I also got an unlawful detainer", "ca-ud"], ["yes, and a CP2000 from the IRS", "irs-cp2000"]]) {
      const r = await at(["I got a notice of default on my house", "it's from my HOA"], reply);
      assert.equal(r.done, false, reply); assert.equal(r.letter, letter, reply);
    }
    const hoaUd = await at(["I got a notice of default on my house"], "my HOA is foreclosing, and I also got an unlawful detainer");
    assert.equal(hoaUd.letter, "ca-ud"); assert.doesNotMatch(hoaUd.say, /^If your homeowners association/);
    // An HOA mention with another letter in the same breath, after a notice of default or a trustee's sale was answered,
    // or after the HOA step: that letter is taken up (the HOA step isn't also said in that turn). Naming the letter just
    // answered isn't another letter: "it's from my HOA, it's the notice of default" still gets the step.
    const STEP = /^If your homeowners association is foreclosing/;
    for (const setup of [["I got a notice of default on my house"], ["I got a notice of default on my house", "it's from my HOA"], ["I got a notice of trustee's sale"]])
      for (const [reply, letter] of [["it's from my HOA, and I also got an unlawful detainer", "ca-ud"], ["my HOA sent it, and a CP2000 from the IRS too", "irs-cp2000"]]) {
        const r = await at(setup, reply);
        assert.equal(r.letter, letter, `${setup.join(" / ")} → ${reply}`); assert.doesNotMatch(r.say, STEP);
      }
    assert.match((await at(["I got a notice of default on my house"], "it's from my HOA")).say, STEP);
    assert.match((await at(["I got a notice of default on my house"], "it's from my HOA, it's the notice of default")).say, STEP);
    // A failed detection names nothing: a plain "no" or "yes" is answered as before, not an error.
    const failingOnce = (reply) => { let failed = false; return async (name, args) => {
      if (name === "detect_letter" && args.text === reply && !failed) { failed = true; throw new Error("engine down"); }
      return mcp.callTool(name, args);
    }; };
    const more = new Dialog(failingOnce("no"), { today: "2026-09-30" });
    await more.handle("I got a 3 day notice dated September 28");
    assert.equal((await more.handle("no")).done, true);
    const stop = new Dialog(failingOnce("yes"), { today: "2026-09-30" });
    for (const t of ["I got a 30 day notice", "no", "no"]) await stop.handle(t);
    assert.equal((await stop.handle("yes")).done, true);
    // Every way the first detection of a terminal turn can fail (a throw, a DecoderError, nothing returned): the plain
    // answer, as before, at "more", "text", "stop" and the date question.
    const { DecoderError } = await import("../vendor/deadline-decoder-mcp/src/decoder.js");
    const failFirst = (mode) => { let done = false; return async (name, args) => {
      if (name === "detect_letter" && !done) { done = true; if (mode === "throw") throw new Error("engine down"); if (mode === "decoder") throw new DecoderError("engine failed"); return undefined; }
      return mcp.callTool(name, args);
    }; };
    for (const mode of ["throw", "decoder", "undefined"])
      for (const [setup, reply, check] of [
        [MORE, "yes", (a) => assert.match(a.say, /^Here's how I counted\./)], [TEXT, "no", (a) => assert.equal(a.done, true)],
        [STOP, "bye", (a) => assert.equal(a.done, true)], [["I got a 3 day notice"], "no", (a) => assert.match(a.say, /^I still need the date on the letter\./)]]) {
        const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
        for (const t of setup) await d.handle(t);
        d.call = failFirst(mode);
        check(await d.handle(reply));
      }
    // Right after an answer, the letter just answered isn't a new one: these keep their plain meaning.
    for (const [setup, reply, want] of [
      [MORE, "yes, how did you count the 3 day notice", (r) => assert.match(r.say, /^Here's how I counted\./)],
      [MORE, "no, I understand the 3 day notice", (r) => assert.equal(r.done, true)],
      [MORE, "bye, thanks for the 3 day notice help", (r) => assert.equal(r.done, true)],
      [TEXT, "yes please text me about the 3 day notice", (r) => assert.match(r.say, /^Okay\. In the real service I'd text the date/)],
      [TEXT, "no, I understand the 3 day notice", (r) => assert.equal(r.done, true)],
      [TEXT, "bye, thanks for the 3 day notice help", (r) => assert.equal(r.done, true)]]) want(await at(setup, reply));
    // …but at the stop offer a 3-day notice is a new letter (the stop offer there is the 30-day notice's).
    assert.equal((await at(STOP, "yes, I also got a 3 day notice")).letter, "ca-3day");
    // …and at the 3-day notice's own stop offer, naming it keeps the call going (the guard is for "more" and "text" only).
    const own = await at(["I got a 3 day notice", "no", "no"], "yes, I'll look for the date on the 3 day notice");
    assert.equal(own.done, false); assert.equal(own.letter, "ca-3day");
    // The plain replies are unchanged.
    assert.equal((await at(MORE, "no")).done, true);
    assert.match((await at(MORE, "yes")).say, /^Here's how I counted\./);
    // A bare yes or no to a which-kind question the decoder can't settle: the same question again.
    for (const reply of ["yes", "no"]) {
      const r = await at(["I got a notice of default on my house, I also got a summons"], reply);
      assert.equal(r.say, "Is it about an eviction, a lawsuit about money, or jury duty?", reply); assert.equal(r.awaiting, "letter");
    }
    // …while an answer the decoder does settle still settles it (the hearing ask's "no" is "not yet").
    assert.equal((await at(["social security denied me again and my hearing is scheduled"], "no")).letter, "ssa-recon");
  } finally { await mcp.close(); }
});

test("dialog: a polite no is a no at 'Want me to go on to it?' and at the stop offer; 'okay bye' after an answer is a goodbye", async () => {
  const mcp = await startMcp();
  try {
    const END = "This is general information, not legal advice. Goodbye.";
    const SALE = `Okay. Don't put off dealing with the Notice of Trustee's Sale. If you want to catch up on the loan, the cutoff is generally five business days before the sale date, not the sale date itself. Call back if you'd like to go over it, or look for free legal help. ${END}`;
    const NOD = `Okay. Don't put off dealing with the Notice of Default. Call back if you'd like to go over it, or look for free legal help. ${END}`;
    const offered = async (first, reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); const f = await d.handle(first);
      assert.match(f.say, /Want me to go on to it\?$/); return { ...(await d.handle(reply)), letter: d.letter }; };
    const SALE_FIRST = "I got a jury summons, plus a notice of trustee's sale", NOD_FIRST = "I got a jury summons, plus a notice of default";
    // A no with thanks declines the carried letter like "no": its goodbye names it (and, for the sale, says the cutoff).
    for (const reply of ["no thanks", "no thank you", "no thanks, that's all"]) {
      assert.deepEqual([(await offered(SALE_FIRST, reply)).say, (await offered(SALE_FIRST, reply)).done], [SALE, true], reply);
      assert.equal((await offered(NOD_FIRST, reply)).say, NOD, reply);
    }
    // A goodbye without a no is still the plain goodbye; "yes" still takes the letter up.
    for (const reply of ["bye", "thanks", "okay bye"]) assert.equal((await offered(SALE_FIRST, reply)).say, `Okay. ${END}`, reply);
    // Only that offer: a carried letter that has a date to ask ("What date is on it?") keeps the plain goodbye.
    const dated = new Dialog(mcp.callTool, { today: "2026-09-30" });
    assert.match((await dated.handle("I got a jury summons, I also got a 60 day notice to move out")).say, /What date is on it\?$/);
    assert.equal((await dated.handle("no thanks")).say, `Okay. ${END}`);
    // A carried question in the state the page sends (not reached in real flows): a goodbye with a no still ends the call.
    const asked = new Dialog(mcp.callTool, { today: "2026-09-30" }); Object.assign(asked, { letter: "jury-summons", awaiting: "another", carry: ["ask:a summons or court papers"] });
    assert.equal((await asked.handle("no thank you, goodbye")).say, `Okay. ${END}`);
    const yes = await offered(SALE_FIRST, "yes");
    assert.equal(yes.letter, "ca-foreclosure-sale"); assert.equal(yes.done, false); assert.match(yes.say, /^A Notice of Trustee's Sale prints the date/);
    // The stop offer ("Do you want to stop here?"): a no to stopping, with thanks or not, asks the date again, since ending
    // the call on a misread "no" loses the deadline and the caller can still say bye; a yes, a plain goodbye or a goodbye
    // said outright with the no ("no thank you, goodbye") ends it.
    const at = async (setup, reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await d.handle(t); return { ...(await d.handle(reply)), awaiting: d.awaiting }; };
    const STOP = ["I got a 30 day notice", "no", "no"];
    for (const reply of ["no", "nope", "no thanks", "no thank you", "no, that's all", "no thanks, that's all", "nah, I'm good"]) {
      const r = await at(STOP, reply);
      assert.deepEqual([r.done, r.awaiting], [false, "date"], reply); assert.match(r.say, /^Okay\. What day was the notice handed to you\?/, reply);
    }
    for (const reply of ["yes", "bye", "yes thanks", "okay bye", "thanks", "no thank you, goodbye", "thank you so much, goodbye"])
      assert.equal((await at(STOP, reply)).say, `Okay. ${END}`, reply);
    // "okay bye" after an answer is "bye", not a yes to the explanation or the text (carried letter or not); "yes thanks" is a yes.
    const MORE = ["I got a 3 day notice dated September 28"], TEXT = [...MORE, "yes"];
    const MORE2 = ["I got a 3 day notice dated September 28, I also got a 60 day notice to move out"], TEXT2 = [...MORE2, "yes"];
    for (const setup of [MORE, TEXT, MORE2, TEXT2]) {
      assert.deepEqual([(await at(setup, "okay bye")).say, (await at(setup, "okay bye")).done], [`Okay. ${END}`, true], setup.join(" / "));
    }
    assert.match((await at(MORE, "yes thanks")).say, /^Here's how I counted\./);
    assert.match((await at(MORE, "okay")).say, /^Here's how I counted\./);
    assert.equal((await at(TEXT, "yes thanks")).say, `Okay. In the real service I'd text the date and a calendar reminder to this number. ${END}`);
    assert.match((await at(TEXT2, "okay")).say, /^Okay\. In the real service I'd text the date and a calendar reminder to this number\. Now, about a 60-day notice to move out\./);
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
