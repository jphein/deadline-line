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
    // Words besides the date that aren't the letter's or plain receipt phrasing ("county", "stopping"): the date is read
    // back first, and the yes counts from it.
    assert.ok(msgs.some(m => m.type === "line" && /^Just to check: is the date on .* September 1\? Say yes, or give me the date\.$/.test(m.text)));
    ws.send(JSON.stringify({ type: "text", text: "yes" }));
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

test("dialog: a polite no is a no at 'Want me to go on to it?' and at the stop offer; after an answer a goodbye names a carried letter; 'don't hang up' isn't a goodbye", async () => {
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
    // A goodbye without a no names the letter too, as after an answer: the sale's cutoff isn't lost on a "bye"; "yes"
    // still takes the letter up.
    for (const reply of ["bye", "thanks", "okay bye", "yes, bye"]) {
      assert.equal((await offered(SALE_FIRST, reply)).say, SALE, reply); assert.equal((await offered(NOD_FIRST, reply)).say, NOD, reply);
    }
    // A carried letter that has a date to ask ("What date is on it?"): a no or a goodbye declines it with the goodbye that
    // names it; a yes with thanks goes on to its date; a date said with thanks is read.
    const SIXTY_FIRST = "I got a jury summons, I also got a 60 day notice to move out";
    const DATED = `Okay. You also mentioned the 60-day notice to move out: call back right away with its date, or look for free legal help. ${END}`;
    const datedAt = async (reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      assert.match((await d.handle(SIXTY_FIRST)).say, /What date is on it\?$/); return { ...(await d.handle(reply)), letter: d.letter }; };
    for (const reply of ["no thanks", "no thank you, goodbye", "bye", "thanks", "not today, thanks", "no thanks, not today", "no thanks, yesterday was bad enough"])
      assert.equal((await datedAt(reply)).say, DATED, reply);
    // A no without thanks or a goodbye isn't a decline there: as at the date question, the letter is taken up and its date
    // asked, and a second no offers to stop. A relative day said with a no or a "not" is never its date.
    for (const reply of ["no", "nope", "nah, I'm good", "no, not the 3rd", "no, one second", "no, not September 3", "not today"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle(SIXTY_FIRST);
      const r = await d.handle(reply);
      assert.deepEqual([r.say, r.done, d.letter, d.date], ["Okay, about a 60-day notice to move out. What date is on it? You can say something like September 13th.", false, "ca-60day-notice", null], reply);
      if (reply !== "not today") assert.equal((await d.handle("no")).say, "If you find the date, call back right away: some of these run out in days. Do you want to stop here?", reply);
    }
    // At the date question too: a relative day with a no is never the date; said with thanks it is the goodbye, without
    // it the date is asked again.
    for (const reply of ["not today, thanks", "no thanks, not today", "no thanks, yesterday was bad enough"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 30 day notice");
      const r = await d.handle(reply); assert.deepEqual([r.say, d.date], [`Okay. ${END}`, null], reply);
    }
    for (const reply of ["not today", "no, not September 3"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 30 day notice");
      const r = await d.handle(reply); assert.deepEqual([r.done, d.date, d.awaiting], [false, null, "date"], reply);
    }
    for (const reply of ["it was September 3", "September 3", "it's September 3"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 30 day notice");
      assert.match((await d.handle(reply)).say, /^A 30-day notice can't end your tenancy before Saturday, October 3, 2026/, reply);
      assert.match((await datedAt(reply)).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/, reply);
    }
    // A new letter named instead of the carried one (no yes, no or goodbye in it) comes first; the carried one is kept and
    // taken up after it, so the sale's cutoff is still said.
    for (const named of ["I also got a 3 day notice to pay rent or quit", "oh and I also got a 3 day notice dated September 25", "I also got an eviction summons"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle(SALE_FIRST);
      await d.handle(named); if (!/dated/.test(named)) await d.handle("September 25");
      assert.deepEqual(d.carry, ["ca-foreclosure-sale"], named);
      assert.match((await d.handle("no")).say, /^Okay\. A Notice of Trustee's Sale prints the date the home will be sold\./, named);
    }
    for (const reply of ["yes thanks", "yes, thank you"]) {
      const r = await datedAt(reply);
      assert.deepEqual([r.say, r.done, r.letter], ["Okay, about a 60-day notice to move out. What date is on it? You can say something like September 13th.", false, "ca-60day-notice"], reply);
    }
    for (const reply of ["September 3", "it was September 3", "it's September 3"])
      assert.match((await datedAt(reply)).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/, reply);
    // A carried question in the state the page sends (not reached in real flows): a goodbye with a no ends the call, naming it.
    const asked = new Dialog(mcp.callTool, { today: "2026-09-30" }); Object.assign(asked, { letter: "jury-summons", awaiting: "another", carry: ["ask:a summons or court papers"] });
    assert.equal((await asked.handle("no thank you, goodbye")).say, `Okay. You also mentioned the summons or court papers: call back right away about it, or look for free legal help. ${END}`);
    // A different letter named at the offer comes first, and the carried one is kept for after it.
    const other = new Dialog(mcp.callTool, { today: "2026-09-30" }); await other.handle(NOD_FIRST);
    assert.equal((await other.handle("before you say goodbye, I also got a summons")).say, "Is it about an eviction, a lawsuit about money, or jury duty?");
    assert.deepEqual(other.carry, ["ca-foreclosure-nod"]);
    await other.handle("an eviction");
    assert.match((await other.handle("September 29")).say, /You also mentioned a Notice of Default; tell me about that next\. Want me to explain how I counted\?$/);
    const three = new Dialog(mcp.callTool, { today: "2026-09-30" }); await three.handle(NOD_FIRST);
    await three.handle("yes, and I also got a 3 day notice"); assert.deepEqual([three.letter, three.carry], ["ca-3day", ["ca-foreclosure-nod"]]);
    // A yes with thanks takes the carried letter up, like "yes" (sale and NOD); a no said with a goodbye is still a decline,
    // so it keeps the goodbye that names the letter (for the sale, the cutoff is still the one fact to hear).
    for (const reply of ["yes thanks", "yes please", "yes, thank you"]) {
      const r = await offered(SALE_FIRST, reply);
      assert.deepEqual([r.letter, r.done], ["ca-foreclosure-sale", false], reply); assert.match(r.say, /^A Notice of Trustee's Sale prints the date/, reply);
      assert.match((await offered(NOD_FIRST, reply)).say, /^A Notice of Default starts the foreclosure clock/, reply);
    }
    assert.equal((await offered(SALE_FIRST, "no thank you, goodbye")).say, SALE);
    // A no wins over a yes-word said with it: "yeah no thanks", "okay, no thanks" and "no thanks, okay" decline (the
    // goodbye names the letter, so a caller who meant yes still hears what to do and can call back). The rule's one
    // exception, a design choice: a no that ends in a yes ("no, okay go ahead", "no wait, yes") is a self-correction, and
    // the yes wins.
    for (const reply of ["yeah no thanks", "okay, no thanks", "sure, no thank you", "no thanks, okay"]) {
      assert.equal((await offered(SALE_FIRST, reply)).say, SALE, reply); assert.equal((await offered(NOD_FIRST, reply)).say, NOD, reply);
    }
    for (const reply of ["no, okay go ahead", "no wait, yes"]) {
      const r = await offered(SALE_FIRST, reply);
      assert.deepEqual([r.letter, r.done], ["ca-foreclosure-sale", false], reply); assert.match(r.say, /^A Notice of Trustee's Sale prints the date/, reply);
      assert.match((await offered(NOD_FIRST, reply)).say, /^A Notice of Default starts the foreclosure clock/, reply);
    }
    // "No, don't hang up": the decline, and the line stays open; "yes, please don't hang up" takes the letter up.
    const staying = await offered(SALE_FIRST, "no, don't hang up");
    assert.deepEqual([staying.say, staying.done], [SALE.replace(END, "I'm still here: tell me about another letter, or say goodbye when you're done."), false]);
    assert.equal((await offered(NOD_FIRST, "yes, please don't hang up")).letter, "ca-foreclosure-nod");
    // Only with a letter offered: "yes thanks" to "Do you have another letter?" is still the plain goodbye, as before.
    const plain = new Dialog(mcp.callTool, { today: "2026-09-30" }); await plain.handle("I got a jury summons");
    assert.equal((await plain.handle("yes thanks")).say, `Okay. ${END}`);
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
    // A negated goodbye ("don't hang up") at the stop offer is a no to stopping: the date again.
    for (const reply of ["no, don't hang up", "yes, please don't hang up", "don't hang up"]) {
      const r = await at(STOP, reply);
      assert.deepEqual([r.done, r.awaiting], [false, "date"], reply); assert.match(r.say, /^Okay\. What day was the notice handed to you\?/, reply);
    }
    // After an answer (the explain and text offers), a goodbye never drops a letter the caller also mentioned: it names it,
    // the way the go-on offer's decline does (an undated one "Don't put off …", the sale with its cutoff; a dated one or a
    // carried question "call back with its date / about it"). A yes said with a goodbye ("yes, bye", "okay bye", "explain
    // it, then hang up") is carried out first (the explanation, the text line), then that goodbye.
    const MORE = ["I got a 3 day notice dated September 28"], TEXT = [...MORE, "yes"];
    const also = (what) => [`I got a 3 day notice dated September 28, ${what}`];
    const CB = "Call back if you'd like to go over it, or look for free legal help. ";
    const TEXTED = "Okay. In the real service I'd text the date and a calendar reminder to this number. ";
    const STILL = "I'm still here: tell me about another letter, or say goodbye when you're done.";
    const CARRIES = [
      [MORE, ""],
      [also("I also got a 60 day notice to move out"), "You also mentioned the 60-day notice to move out: call back right away with its date, or look for free legal help. "],
      [also("plus a notice of default"), `Don't put off dealing with the Notice of Default. ${CB}`],
      [also("plus a notice of trustee's sale"), `Don't put off dealing with the Notice of Trustee's Sale. If you want to catch up on the loan, the cutoff is generally five business days before the sale date, not the sale date itself. ${CB}`],
      [also("I also got a summons"), "You also mentioned the summons or court papers: call back right away about it, or look for free legal help. "],
    ];
    for (const [more, line] of CARRIES) {
      const text = [...more, "yes"], label = more[0];
      for (const reply of ["bye", "bye now", "thanks", "no thanks, goodbye", "no thank you, goodbye"])
        for (const setup of [more, text]) assert.deepEqual([(await at(setup, reply)).say, (await at(setup, reply)).done], [`Okay. ${line}${END}`, true], `${label} / ${setup.length} → ${reply}`);
      for (const reply of ["okay bye", "yes, bye", "explain it, then hang up"]) {
        const r = await at(more, reply);
        assert.match(r.say, /^Here's how I counted\. Served Monday, September 28, 2026\./, reply); assert.ok(r.say.endsWith(`${line}${END}`), `${label} → ${reply}: ${r.say}`); assert.equal(r.done, true);
      }
      for (const reply of ["okay bye", "yes, bye"]) assert.deepEqual([(await at(text, reply)).say, (await at(text, reply)).done], [`${TEXTED}${line}${END}`, true], `${label} → ${reply}`);
      // "Please don't hang up" isn't a goodbye: a yes is a yes, and nothing ends the call.
      const ex = await at(more, "yes, please don't hang up");
      assert.match(ex.say, /^Here's how I counted\..* Would you like me to text you the date\?$/); assert.equal(ex.done, false);
      const tx = await at(text, "yes, please don't hang up");
      assert.ok(tx.say.startsWith(TEXTED), tx.say); assert.equal(tx.done, false);
      if (!line) assert.equal(tx.say, `${TEXTED}${STILL}`);
      for (const reply of ["no, don't hang up", "don't hang up"]) for (const setup of [more, text]) assert.equal((await at(setup, reply)).done, false, `${label} → ${reply}`);
    }
    assert.equal((await at(MORE, "no, don't hang up")).say, `Okay. ${STILL}`);
    // "yes thanks" and "okay" are still a yes at both offers; a plain no with a carried letter still goes on to it.
    assert.match((await at(MORE, "yes thanks")).say, /^Here's how I counted\..* Would you like me to text you the date\?$/);
    assert.match((await at(MORE, "okay")).say, /^Here's how I counted\..* Would you like me to text you the date\?$/);
    assert.equal((await at(TEXT, "yes thanks")).say, `${TEXTED}${END}`);
    const SIXTY = also("I also got a 60 day notice to move out");
    assert.match((await at([...SIXTY, "yes"], "okay")).say, /^Okay\. In the real service I'd text the date and a calendar reminder to this number\. Now, about a 60-day notice to move out\./);
    for (const setup of [SIXTY, [...SIXTY, "yes"]]) assert.match((await at(setup, "no thanks")).say, /^Okay\. Now, about a 60-day notice to move out\./);
    // "Don't hang up" at the date question isn't a goodbye either.
    assert.match((await at(["I got a 30 day notice"], "no, don't hang up")).say, /^I still need the date on the letter\./);
    assert.match((await at(["I got a 30 day notice"], "don't hang up")).say, /^Okay\. What day was the notice handed to you\?/);
    // A goodbye that names a letter is about the letter (namesLetter, the decoder): the summons question, at every offer.
    for (const setup of [STOP, MORE, [...SIXTY, "yes"], ["I got a jury summons"]])
      assert.equal((await at(setup, "before you say goodbye, I also got a summons")).say, "Is it about an eviction, a lawsuit about money, or jury duty?", setup.join(" / "));
  } finally { await mcp.close(); }
});

test("dialog: 'thanks, please don't hang up' keeps the open question; a no comes first at the explain and text offers; every carried letter is named", async () => {
  const mcp = await startMcp();
  try {
    const END = "This is general information, not legal advice. Goodbye.";
    const at = async (setup, reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await d.handle(t);
      const r = await d.handle(reply); return { ...r, d }; };
    const SIXTY = ["I got a 3 day notice dated September 28, I also got a 60 day notice to move out"];
    // A stay request with no answer in it keeps what was open (letter, date, carry, stage) and asks its question again;
    // "I'm still here" only when nothing is open. (At the stop offer it is a no to stopping: the date question.)
    const STAGES = [
      [["I got a 30 day notice"], "date", "What day was the notice handed to you? You can say something like September 13th."],
      [["I got a summons"], "letter", "Is it about an eviction, a lawsuit about money, or jury duty?"],
      [["I got a 30 day notice", "no", "no"], "date", "What day was the notice handed to you? You can say something like September 13th."],
      [["I got a 3 day notice dated September 28"], "more", "Want me to explain how I counted?"],
      [["I got a 3 day notice dated September 28", "yes"], "text", "Would you like me to text you the date?"],
      [SIXTY, "more", "Want me to explain how I counted?"],
      [[...SIXTY, "yes"], "text", "Would you like me to text you the date?"],
      [["I got a jury summons, plus a notice of trustee's sale"], "another", "Want me to go on to it?"],
      [["I got a jury summons, I also got a 60 day notice to move out"], "another", "What date is on it?"],
      [["I got a jury summons"], "another", "Do you have another letter I can help with?"],
    ];
    for (const [setup, stage, ask] of STAGES) for (const reply of ["thanks, please don't hang up", "thanks, hold on", "thank you, please don\u2019t hang up"]) {
      const before = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await before.handle(t);
      const { letter, date, carry } = before;
      const r = await before.handle(reply);
      assert.deepEqual([r.say, r.done, before.awaiting], [`Okay. ${ask}`, false, stage], `${setup.join(" / ")} → ${reply}`);
      if (stage !== "date" || setup.length === 1) assert.deepEqual([before.letter, before.date, before.carry], [letter, date, carry], `${setup.join(" / ")} → ${reply}`);
    }
    // …and what was open is still answerable: the carried sale is taken up, the date is read.
    const kept = await at(["I got a jury summons, plus a notice of trustee's sale", "thanks, please don't hang up"], "yes");
    assert.match(kept.say, /^A Notice of Trustee's Sale prints the date/);
    assert.match((await at(["I got a 30 day notice", "thanks, please don't hang up"], "September 25")).say, /^A 30-day notice can't end your tenancy before Sunday, October 25, 2026/);
    // At the date question, with or without thanks and words after it: the letter is kept, so the date is read for it.
    for (const reply of ["thanks, don't hang up", "thank you, don't hang up, I'm looking for it", "okay thanks, don't hang up, let me find it", "hold on, don't hang up", "wait, don't hang up"]) {
      const r = await at(["I got a 30 day notice", reply], "September 25");
      assert.match(r.say, /^A 30-day notice can't end your tenancy before Sunday, October 25, 2026/, reply);
    }
    // A stay that leaves a goodbye behind isn't one ("don't hang up, bye"), and "never mind hang up" (no comma, as ASR
    // writes it) is a goodbye like "never mind, hang up".
    for (const setup of [["I got a 30 day notice"], ["I got a 3 day notice dated September 28"], ["I got a jury summons, plus a notice of trustee's sale"], ["I got a jury summons"]])
      for (const reply of ["never mind hang up", "never mind, hang up", "don't hang up, bye"])
        assert.equal((await at(setup, reply)).done, true, `${setup.join(" / ")} → ${reply}`);
    // "Please stay on the line" isn't a yes: the open question again.
    assert.equal((await at(["I got a 3 day notice dated September 28"], "please stay on the line")).say, "Okay. Want me to explain how I counted?");
    assert.equal((await at(["I got a jury summons, plus a notice of trustee's sale"], "please stay on the line")).say, "Okay. Want me to go on to it?");
    // The date question's "no" count is kept too: a second "no" after the stay request offers to stop.
    assert.equal((await at(["I got a 30 day notice", "no", "thanks, please don't hang up"], "no")).say, "If you find the date, call back right away: some of these run out in days. Do you want to stop here?");
    assert.equal((await at([], "thanks, please don't hang up")).say, "Okay. I'm still here: tell me about another letter, or say goodbye when you're done.");
    // A bare "don't hang up", "stay on the line please" or "please don\u2019t hang up" ends the call at no stage, changes
    // nothing, and asks the open question again (at the stop offer: the date, a no to stopping).
    for (const [setup, stage, ask] of STAGES) for (const reply of ["don't hang up", "stay on the line please", "please don\u2019t hang up", "hold the line"]) {
      const r = await at(setup, reply);
      assert.deepEqual([r.say, r.done, r.d.awaiting], [`Okay. ${ask}`, false, stage], `${setup.join(" / ")} → ${reply}`);
    }
    // A stay said with something else in it is read for that: the date, or a letter named.
    assert.match((await at(["I got a 30 day notice"], "hold on, it was September 25")).say, /^A 30-day notice can't end your tenancy before Sunday, October 25, 2026/);
    // The curly apostrophe is read as the plain one: "yes, please don\u2019t hang up" is a yes.
    assert.match((await at(["I got a 3 day notice dated September 28"], "yes, please don\u2019t hang up")).say, /^Here's how I counted\..* Would you like me to text you the date\?$/);
    // "Before you hang up" isn't a stay: "before you hang up, thanks, goodbye" ends the call; "before you say goodbye, I also
    // got a summons" still names a letter (the decoder), so it is the summons question.
    for (const setup of [["I got a 30 day notice"], ["I got a 3 day notice dated September 28"], ["I got a jury summons"]]) {
      for (const reply of ["before you hang up, thanks, goodbye", "before you hang up, thanks so much"]) assert.equal((await at(setup, reply)).done, true, `${setup.join(" / ")} → ${reply}`);
      assert.equal((await at(setup, "before you say goodbye, I also got a summons")).say, "Is it about an eviction, a lawsuit about money, or jury duty?", setup.join(" / "));
    }
    // At the explain and text offers a no comes first, as at the go-on offer: "okay, no thank you, goodbye" neither explains
    // nor texts; it ends, naming a letter carried. A no that asks how ("no, how did you count it?") still explains.
    const LINE60 = "You also mentioned the 60-day notice to move out: call back right away with its date, or look for free legal help. ";
    // After the "Don't put off" line, free legal help isn't said twice.
    const REST60 = "You also mentioned the 60-day notice to move out: call back right away with its date. ";
    for (const [setup, line] of [[["I got a 3 day notice dated September 28"], ""], [["I got a 3 day notice dated September 28", "yes"], ""], [SIXTY, LINE60], [[...SIXTY, "yes"], LINE60]])
      for (const reply of ["okay, no thank you, goodbye", "yes, no thanks, bye"])
        assert.deepEqual([(await at(setup, reply)).say, (await at(setup, reply)).done], [`Okay. ${line}${END}`, true], `${setup.join(" / ")} → ${reply}`);
    assert.match((await at(SIXTY, "okay, no thanks")).say, /^Okay\. Now, about a 60-day notice to move out\./);
    assert.match((await at(["I got a 3 day notice dated September 28"], "no, how did you count it?")).say, /^Here's how I counted\./);
    assert.match((await at(["I got a 3 day notice dated September 28"], "no, okay go ahead")).say, /^Here's how I counted\..* Would you like me to text you the date\?$/);
    // A goodbye after an answer names every letter carried: an undated first one "Don't put off …", then the rest.
    const pair = new Dialog(mcp.callTool, { today: "2026-09-30" }); await pair.handle("I got a 3 day notice dated September 28");
    pair.carry = ["jury-summons", "ca-60day-notice"];
    assert.equal((await pair.handle("bye")).say, `Okay. Don't put off dealing with the jury summons. Call back if you'd like to go over it, or look for free legal help. ${REST60}${END}`);
    const two = new Dialog(mcp.callTool, { today: "2026-09-30" }); await two.handle("I got a 3 day notice dated September 28");
    two.carry = ["jury-summons", "ca-60day-notice", "ca-foreclosure-nod"];
    assert.match((await two.handle("bye")).say, /^Okay\. Don't put off dealing with the jury summons\. .*You also mentioned the 60-day notice to move out and the Notice of Default: call back right away about them\. /);
    const three = new Dialog(mcp.callTool, { today: "2026-09-30" }); await three.handle("I got a 3 day notice dated September 28");
    three.carry = ["ca-60day-notice", "ca-30day-notice", "ca-foreclosure-nod"];
    assert.match((await three.handle("bye")).say, /^Okay\. You also mentioned the 60-day notice to move out, the 30-day notice to move out and the Notice of Default: call back right away about them, or look for free legal help\. /);
    // The sale's cutoff is said whenever the sale is carried, first or not.
    const saleSecond = new Dialog(mcp.callTool, { today: "2026-09-30" }); await saleSecond.handle("I got a 3 day notice dated September 28");
    saleSecond.carry = ["jury-summons", "ca-foreclosure-sale"];
    assert.equal((await saleSecond.handle("bye")).say, `Okay. Don't put off dealing with the jury summons. Call back if you'd like to go over it, or look for free legal help. You also mentioned the Notice of Trustee's Sale: call back right away about it. For the Notice of Trustee's Sale: if you want to catch up on the loan, the cutoff is generally five business days before the sale date, not the sale date itself. ${END}`);
    const goOnTwo = new Dialog(mcp.callTool, { today: "2026-09-30" }); Object.assign(goOnTwo, { letter: "jury-summons", awaiting: "another", carry: ["ca-foreclosure-nod", "ca-foreclosure-sale"] });
    assert.match((await goOnTwo.handle("no thanks")).say, /^Okay\. Don't put off dealing with the Notice of Default\. .*You also mentioned the Notice of Trustee's Sale: .*For the Notice of Trustee's Sale: if you want to catch up on the loan, the cutoff is generally five business days before the sale date/);
    // "I don't want to hang up" / "I don't need you to hang up" ask the line to stay: a carried letter is taken up, not dropped.
    for (const reply of ["no, I don't want to hang up", "no, I don't need you to hang up"]) {
      const r = await at(SIXTY, reply);
      assert.equal(r.done, false, reply); assert.match(r.say, /^Okay\. Now, about a 60-day notice to move out\./, reply);
    }
    assert.equal((await at(["I got a 3 day notice dated September 28"], "I don't want to hang up")).done, false);
    const undated2 = new Dialog(mcp.callTool, { today: "2026-09-30" }); await undated2.handle("I got a 3 day notice dated September 28");
    undated2.carry = ["jury-summons", "ca-foreclosure-nod"];
    assert.match((await undated2.handle("bye")).say, /You also mentioned the Notice of Default: call back right away about it\. /);
  } finally { await mcp.close(); }
});

test("dialog: a date is read before any goodbye or stay; 'wait' only as an instruction; a negated yes or a denied date isn't one", async () => {
  const mcp = await startMcp();
  try {
    const END = "This is general information, not legal advice. Goodbye.";
    const at = async (setup, reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await d.handle(t);
      const r = await d.handle(reply); return { ...r, d }; };
    const DATE = ["I got a 30 day notice"], STOP = ["I got a 30 day notice", "no", "no"];
    const SIXTY = ["I got a jury summons, I also got a 60 day notice to move out"], SALE = ["I got a jury summons, plus a notice of trustee's sale"];
    const THIRTY = /^A 30-day notice can't end your tenancy before Saturday, October 3, 2026/, SIXTY_ANS = /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/;
    // W1: the date is looked for before any goodbye or stay, at the date question, the stop offer and the carried date
    // offer; a no correcting the date keeps the letter. (Said with thanks, the date is read back first: commit 5.)
    for (const reply of ["September 3, thanks, please don't hang up", "no, it was September 3, thanks, please don't hang up", "September 3, thanks"]) {
      for (const [setup, letter] of [[DATE, "ca-30day-notice"], [STOP, "ca-30day-notice"], [SIXTY, "ca-60day-notice"]]) {
        const r = await at(setup, reply);
        assert.match(r.say, /^Just to check: was the (30|60)-day notice to move out handed to you on September 3\? Say yes, or give me the date\.$/, `${setup.length} → ${reply}`);
        assert.deepEqual([r.d.letter, r.d.date, r.d.awaiting], [letter, "2026-09-03", "date"], reply);
      }
      assert.match((await at([...DATE, reply], "yes")).say, THIRTY, reply); assert.match((await at([...SIXTY, reply], "yes")).say, SIXTY_ANS, reply);
    }
    // W2: "wait" is a stay only as an instruction ("wait a second", "please wait"), never "I can't wait" or "I'll wait for
    // the mail": a decline with "I can't wait" ends the call, and "yes, I can't wait" at the stop offer stops.
    assert.deepEqual([(await at(SALE, "no thanks, I can't wait")).done, (await at(SALE, "no thanks, I can't wait")).d.awaiting], [true, null]);
    assert.match((await at(SALE, "no thanks, I can't wait")).say, /^Okay\. Don't put off dealing with the Notice of Trustee's Sale\./);
    assert.equal((await at(STOP, "yes, I can't wait")).say, `Okay. ${END}`);
    for (const reply of ["I'll wait for the mail", "I'm waiting on the letter", "I couldn't wait", "I'll hold on to the letter", "we should wait for the mail"]) assert.equal((await at(["I got a 3 day notice dated September 28"], reply)).d.staying, false, reply);
    for (const [setup, ask] of [[DATE, "What day was the notice handed to you? You can say something like September 13th."], [SALE, "Want me to go on to it?"], [["I got a 3 day notice dated September 28"], "Want me to explain how I counted?"]])
      for (const reply of ["wait a second", "please wait", "wait"]) assert.equal((await at(setup, reply)).say, `Okay. ${ask}`, reply);
    // W3: a no that ends in a negated yes is a no: "no, I'm not saying yes", "no, not yes" decline; "no, okay go ahead" and
    // "no wait, yes" still accept.
    for (const reply of ["no, I'm not saying yes", "no, not yes", "no, don't go ahead"]) {
      const r = await at(SALE, reply); assert.equal(r.done, true, reply); assert.match(r.say, /^Okay\. Don't put off dealing with the Notice of Trustee's Sale\./, reply);
      assert.equal((await at(["I got a 3 day notice dated September 28"], reply)).say, `Okay. ${END}`, reply);
    }
    for (const reply of ["no, okay go ahead", "no wait, yes"]) assert.equal((await at(SALE, reply)).d.letter, "ca-foreclosure-sale", reply);
    // W4: a date denied in the same breath isn't a date (the decoder reads "September 3"): at the carried date offer it is a
    // decline, at the date question and the stop offer the date is asked again, and after an answer the date stays.
    assert.equal((await at(SIXTY, "no thanks, September 3 isn't the date")).say, `Okay. You also mentioned the 60-day notice to move out: call back right away with its date, or look for free legal help. ${END}`);
    assert.match((await at(SIXTY, "September 3 is not the date")).say, /^Okay, about a 60-day notice to move out\. What date is on it\?/);
    for (const [setup, again] of [[DATE, /^I still need the date on the letter\./], [STOP, /^(I still need the date on the letter\.|Okay\.) What day was the notice handed to you\?/]])
      for (const reply of ["no thanks, September 3 isn't the date", "September 3 is not the date"]) {
        const r = await at(setup, reply); assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, null, "date"], reply); assert.match(r.say, again, reply);
      }
    assert.match((await at(["I got a 3 day notice dated September 28"], "September 3 is not the date")).say, /^Your deadline is Thursday, October 1, 2026\./);
    // N3: at an open date question a no said with a stay is a no to hanging up, not to the letter: the question stays.
    for (const [setup, ask] of [[DATE, "What day was the notice handed to you? You can say something like September 13th."], [SIXTY, "What date is on it?"]])
      for (const reply of ["no thanks, don't hang up", "no, please don't hang up"]) {
        const r = await at(setup, reply); assert.equal(r.done, false, reply); assert.ok(r.say.endsWith(ask.replace(/^What date is on it\?$/, "What date is on it?")) || r.say.includes(ask), `${reply}: ${r.say}`);
        assert.ok(["date", "another"].includes(r.d.awaiting), reply);
      }
    const kept = await at(DATE, "no thanks, don't hang up"); assert.equal(kept.d.letter, "ca-30day-notice");
    // N-b: "I don't want you to hang up" is a stay with nothing else in it: the open question again.
    assert.equal((await at(["I got a 3 day notice dated September 28"], "I don't want you to hang up")).say, "Okay. Want me to explain how I counted?");
    assert.equal((await at(DATE, "we don't want you to hang up")).say, "Okay. What day was the notice handed to you? You can say something like September 13th.");
  } finally { await mcp.close(); }
});

test("dialog: a date said with a negation, a hedge, thanks or a goodbye is read back before anything is counted from it", async () => {
  const mcp = await startMcp();
  try {
    const END = "This is general information, not legal advice. Goodbye.";
    const at = async (setup, reply) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await d.handle(t);
      const r = await d.handle(reply); return { ...r, d }; };
    const DATE = ["I got a 3 day notice"], STOP = ["I got a 3 day notice", "no", "no"], SIXTY = ["I got a jury summons, I also got a 60 day notice to move out"];
    const MORE = ["I got a 3 day notice dated September 25"], TEXT = [...MORE, "yes"];
    const STAGES = [[DATE, "the 3-day notice"], [STOP, "the 3-day notice"], [SIXTY, "the 60-day notice to move out"]];
    const CHECK = (letter, day) => `Just to check: was ${letter} handed to you on ${day}? Say yes, or give me the date.`;
    const DECLINED = `Okay. You also mentioned the 60-day notice to move out: call back right away with its date, or look for free legal help. ${END}`;
    const asked = (r, reply) => assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, null, "date"], reply);
    // (1) A date with a negation, a hedge, a thanks or goodbye word, or a "?" is read back, never counted from; the date
    // is held for the answer to the check.
    for (const reply of ["no thanks, it wasn't September 3", "no thanks, it isn't September 3", "thanks, but it wasn't September 3", "no thanks, I don't think it was September 3",
      "no thanks, not sure it was September 3", "maybe September 3", "no thanks, maybe September 3", "September 3?", "September 3, thanks", "September 3, bye"])
      for (const [setup, letter] of [...STAGES, [MORE, "the 3-day notice"], [TEXT, "the 3-day notice"]]) {
        const r = await at(setup, reply);
        assert.deepEqual([r.say, r.done, r.d.date, r.d.awaiting], [CHECK(letter, "September 3"), false, "2026-09-03", "date"], `${setup.join(" / ")} → ${reply}`);
      }
    // …"yes" counts from it (with a goodbye too), a new date is used, "no" asks the date again (a second "no" offers to
    // stop), a goodbye ends, a stay request asks the check again, and "say that again" repeats it.
    const HELD = [...DATE, "September 3, thanks"];
    for (const reply of ["yes", "yes, bye", "yes, it was September 3"]) assert.match((await at(HELD, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    assert.match((await at(HELD, "September 5")).say, /^That deadline was Thursday, September 10, 2026\./);
    const no = await at(HELD, "no"); assert.equal(no.say, "Okay. What date is on it? You can say something like September 13th."); asked(no, "no");
    assert.match((await at([...HELD, "no"], "no")).say, /Do you want to stop here\?$/);
    assert.equal((await at(HELD, "bye")).say, `Okay. ${END}`);
    for (const reply of ["thanks, please don't hang up", "say that again"]) assert.match((await at(HELD, reply)).say, /Just to check: was the 3-day notice handed to you on September 3\? Say yes, or give me the date\.$/, reply);
    assert.match((await at([...SIXTY, "September 3, thanks"], "yes")).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/);
    // …and the held date survives the page's round trip (cleanState keeps the stage and the date).
    const { decodeHandlers } = await import("../src/handlers.js");
    const h = decodeHandlers({ callTool: mcp.callTool }); let state = null, said = "";
    for (const transcript of ["I got a 3 day notice", "September 3, thanks", "yes"]) {
      const r = await (await h.POST(new Request("https://demo.example/api/decode", { method: "POST", body: JSON.stringify({ transcript, state, today: "2026-09-30" }) }))).json();
      state = r.state; said = r.say;
    }
    assert.match(said, /^That deadline was Wednesday, September 9, 2026\./);
    // "say that again" on the round trip rebuilds the check from the state (the line said last isn't kept).
    state = null;
    for (const transcript of ["I got a 3 day notice", "September 3, thanks", "say that again"]) {
      const r = await (await h.POST(new Request("https://demo.example/api/decode", { method: "POST", body: JSON.stringify({ transcript, state, today: "2026-09-30" }) }))).json();
      state = r.state; said = r.say;
    }
    assert.equal(said, "Just to check: was the 3-day notice handed to you on September 3? Say yes, or give me the date.");
    // (2) A bare date (no marker at all) is counted from directly.
    for (const reply of ["September 3", "it was September 3", "it's September 3", "actually it was September 3"]) {
      assert.match((await at(DATE, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
      assert.match((await at(SIXTY, reply)).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/, reply);
      assert.match((await at(MORE, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);   // a correction re-dates
    }
    // (3) Two dates, one taken back: the other one is the one read back (a negation in the turn means a check, never a
    // direct count); its plain yes counts from it. So does "no, it was September 3" (W-b: one extra turn, the safe side).
    for (const [reply, day, want] of [["it wasn't September 3, it was September 25", "September 25", /^Your deadline is Wednesday, September 30, 2026\./], ["no, it was not the 3rd, it was September 5", "September 5", /^That deadline was Thursday, September 10, 2026\./],
      ["September 25, not September 3", "September 25", /^Your deadline is Wednesday, September 30, 2026\./], ["not today, it was September 3", "September 3", /^That deadline was Wednesday, September 9, 2026\./],
      ["no, it was September 3", "September 3", /^That deadline was Wednesday, September 9, 2026\./], ["not September 2, September 3", "September 3", /^That deadline was Wednesday, September 9, 2026\./]])
      for (const setup of [DATE, STOP, MORE]) {
        assert.equal((await at(setup, reply)).say, CHECK("the 3-day notice", day), `${setup.join(" / ")} → ${reply}`);
        assert.match((await at([...setup, reply], "yes")).say, want, `${setup.join(" / ")} → ${reply} → yes`);
      }
    for (const reply of ["no, it was September 3", "September 3, but that's wrong", "September 3, no that's wrong"])
      assert.equal((await at(SIXTY, reply)).say, CHECK("the 60-day notice to move out", "September 3"), reply);
    const re = new Dialog(mcp.callTool, { today: "2026-09-30" }); re.letter = "ca-3day";   // the decoder picked the denied one
    assert.deepEqual(await re.dateTurn("no, not September 3, it was September 5", { suggested_notice_date: "2026-09-03" }), { kind: "confirm", date: "2026-09-05" });
    // After an answer, a reply whose only date is taken back isn't a correction: it is the offer's own no ("no, not
    // September 3" at "Want me to explain how I counted?" is the goodbye).
    assert.equal((await at(MORE, "no, not September 3")).say, `Okay. ${END}`);
    // A date taken back outright, or the other letter's: the date is asked again.
    for (const reply of ["September 3? no", "no, not September 3", "I got it on September 3, no wait, that's the other letter", "September 3, wrong letter"])
      for (const setup of [DATE, STOP]) asked(await at(setup, reply), reply);
    // A date the decoder can't read ("February 30", "the 3rd"): asked again, never a goodbye or a deadline.
    for (const reply of ["February 30, thanks", "thanks, it was served on the 3rd", "not until September 3"]) {
      for (const setup of [DATE, STOP]) asked(await at(setup, reply), reply);
      assert.match((await at(SIXTY, reply)).say, /^Okay, about a 60-day notice to move out\. What date is on it\?/, reply);
      const m = await at(MORE, reply); asked(m, reply); assert.match(m.say, /^I still need the date on the letter\./, reply);
    }
    // (4) A relative day with a no, a "not" or a plan is never the date: with thanks or a goodbye it is the goodbye (the
    // carried letter named), without them the date is asked again; with a past receipt and thanks it is read back; alone
    // it is the date.
    for (const reply of ["thanks, I'll look for it today", "thanks, I'll find it later today", "thank you, I'll get back to you today", "I'll look for it today, bye",
      "no thanks, yesterday I got 2 calls", "no thanks, yesterday may be wrong", "not today, thanks", "thanks, I'll call back tomorrow", "thanks, I'll call back tonight",
      "okay thanks, I'll check this afternoon", "thanks, I'll call back Monday", "thanks, I'll call back next week"]) {
      assert.equal((await at(DATE, reply)).say, `Okay. ${END}`, reply);
      // At the stop offer a "no thanks" is a no to stopping (the date again), the stop offer's own rule; never a date.
      const st = await at(STOP, reply);
      if (/^no thanks/.test(reply)) asked(st, reply); else assert.equal(st.say, `Okay. ${END}`, reply);
      assert.equal((await at(SIXTY, reply)).say, DECLINED, reply);
    }
    for (const reply of ["I'll look for it today", "no, today", "not today"]) { asked(await at(DATE, reply), reply); asked(await at(SIXTY, reply), reply); }
    for (const reply of ["thank you, I got it yesterday", "it came yesterday, thanks"])
      for (const [setup, letter] of [...STAGES, [MORE, "the 3-day notice"]]) assert.equal((await at(setup, reply)).say, CHECK(letter, "September 29"), `${setup.join(" / ")} → ${reply}`);
    for (const reply of ["yesterday", "I got it yesterday"]) {
      assert.match((await at(DATE, reply)).say, /^Your deadline is Friday, October 2, 2026\./, reply);
      assert.match((await at(SIXTY, reply)).say, /^A 60-day notice can't end your tenancy before Saturday, November 28, 2026/, reply);
    }
    // (6) A goodbye said outright is honored even when a date is denied (only thanks yields to a denial); a stay keeps it.
    for (const reply of ["goodbye, yesterday isn't the date", "goodbye, September 3 isn't the date"]) {
      for (const setup of [DATE, STOP]) assert.equal((await at(setup, reply)).say, `Okay. ${END}`, reply);
      assert.equal((await at(SIXTY, reply)).say, DECLINED, reply);
    }
    assert.equal((await at(["I got a 3 day notice, I also got a 60 day notice to move out"], "goodbye, yesterday isn't the date")).say, DECLINED);
    asked(await at(DATE, "no thanks, September 3 isn't the date"), "thanks yields");
    assert.equal((await at(DATE, "yesterday isn't the date, please don't hang up")).done, false);
    // X1: a date denied with "is not correct" / "is wrong" is asked again, at every stage and at the check.
    const CHECKED = [...DATE, "September 3, thanks"];
    for (const reply of ["September 3 is not correct", "September 3 is not right", "September 3 is wrong"]) {
      for (const setup of [DATE, STOP, CHECKED]) asked(await at(setup, reply), reply);
      assert.match((await at(SIXTY, reply)).say, /^Okay, about a 60-day notice to move out\. What date is on it\?/, reply);
    }
    // …while a "not" that isn't attached to the date is still a marker: read back ("I'm not sure, September 3").
    for (const [setup, letter] of [...STAGES, [CHECKED, "the 3-day notice"]]) assert.equal((await at(setup, "I'm not sure, September 3")).say, CHECK(letter, "September 3"));
    // Rule C: a chatty restatement of the held date gets the check once more, then the date is asked.
    for (const reply of ["I'm not sure, September 3", "I believe September 3"]) {
      const twice = await at([...CHECKED, reply], reply); asked(twice, `twice: ${reply}`);
    }
    // X2: the markers apply to any date the decoder reads, lexical candidate or not ("Maybe 2026-09-03"; a spoken ordinal
    // once the decoder reads it); a date neither can read with thanks is asked again, not a goodbye.
    const x2 = new Dialog(mcp.callTool, { today: "2026-09-30" }); x2.letter = "ca-3day";
    assert.deepEqual(await x2.dateTurn("Maybe 2026-09-03", { suggested_notice_date: "2026-09-03" }), { kind: "confirm", date: "2026-09-03" });
    assert.deepEqual(await x2.dateTurn("September third, I think", { suggested_notice_date: "2026-09-03" }), { kind: "confirm", date: "2026-09-03" });
    // (A date read only by the decoder can't be told apart from the words around it: read back, the safe side.)
    assert.deepEqual(await x2.dateTurn("September third", { suggested_notice_date: "2026-09-03" }), { kind: "confirm", date: "2026-09-03" });
    assert.deepEqual(await x2.dateTurn("no, September third", { suggested_notice_date: "2026-09-03" }), { kind: "confirm", date: "2026-09-03" });   // W-b, decoder-only
    for (const setup of [DATE, STOP]) for (const reply of ["2026-09-03, thanks", "Maybe 2026-09-03"]) asked(await at(setup, reply), reply);
    // X3: at the check, a yes with a new day in it is read as that day, never the held one.
    // (Said with a yes, the new day isn't bare, so it is the one read back.)
    for (const [reply, day] of [["Yes, actually it was yesterday", "September 29"], ["yes, it was today", "September 30"]]) {
      const r = await at(CHECKED, reply); assert.equal(r.say, CHECK("the 3-day notice", day), reply);
      assert.match((await at([...CHECKED, reply], "yes")).say, day === "September 29" ? /^Your deadline is Friday, October 2, 2026\./ : /^Your deadline is Monday, October 5, 2026\./, reply);
    }
    // X4 / P1: at the check a yes is a plain one. A negated, hedged or questioning answer is never a yes ("I'm not sure",
    // "that's not right", "right?", "yes?", "yes, maybe"): the date is asked again. "sure, I guess" and "yeah, I think
    // so" are yeses.
    const HELD60 = [...SIXTY, "September 3, thanks"];
    for (const reply of ["I'm not sure", "not sure", "that's not right", "right?", "yes?", "Yes, maybe", "not really", "I don't think so", "I don't know", "probably", "maybe", "no thanks"])
      for (const setup of [CHECKED, [...STOP, "September 3, thanks"], HELD60]) asked(await at(setup, reply), `${setup.length} → ${reply}`);
    for (const reply of ["that's right", "correct", "yep", "yes it was September 3"]) {
      assert.match((await at(CHECKED, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
      assert.match((await at(HELD60, reply)).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/, reply);
    }
    // P2: the check starts the "no" count afresh: a "no" before it doesn't turn a correction into the stop offer.
    const NOFIRST = [...DATE, "no thanks, it wasn't September 3"];
    assert.equal((await at(NOFIRST, "no, it was September 25")).say, CHECK("the 3-day notice", "September 25"));
    assert.match((await at([...NOFIRST, "no, it was September 25"], "yes")).say, /^Your deadline is Wednesday, September 30, 2026\./);
    asked(await at(NOFIRST, "no thanks"), "P2 no thanks");
    asked(await at(NOFIRST, "no, yesterday"), "P2 no, yesterday");   // not the stop offer
    assert.match((await at([...NOFIRST, "no thanks"], "no")).say, /Do you want to stop here\?$/);
    // A no that only takes a date back is still a no: a second no offers to stop.
    assert.match((await at([...DATE, "no, not September 3"], "no")).say, /Do you want to stop here\?$/);
    // …and a second no that carries a date is that date, not the stop offer.
    assert.equal((await at([...DATE, "no"], "no, it was September 25")).say, CHECK("the 3-day notice", "September 25"));
    assert.match((await at([...DATE, "no"], "no thanks, it wasn't September 3")).say, /^Just to check: was the 3-day notice handed to you on September 3\?/);
    // P3: the check asks for the day that counts, in the letter's own words.
    const named = async (first, date) => (await at([first], date)).say;
    assert.equal(await named("I got a 30 day notice", "September 3, thanks"), "Just to check: was the 30-day notice to move out handed to you on September 3? Say yes, or give me the date.");
    assert.equal(await named("I got a summons for a lawsuit about money", "September 3, thanks"), "Just to check: were the papers handed to you on September 3? Say yes, or give me the date.");
    assert.equal(await named("I got a parking ticket", "September 3, thanks"), "Just to check: is the date on the ticket September 3? Say yes, or give me the date.");
    assert.equal(await named("I got an eviction summons", "September 3, thanks"), "Just to check: were the eviction court papers handed to you on September 3? Say yes, or give me the date.");
    const held = async (letter) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); Object.assign(d, { letter, date: "2026-09-03" }); return d.confirmQuestion(); };
    assert.equal(await held("ca-sheriff-vacate"), "Just to check: was the sheriff's notice handed to you or posted on your door on September 3? Say yes, or give me the date.");
    assert.equal(await held("ssa-initial"), "Just to check: is the date on the Social Security denial September 3? Say yes, or give me the date.");
    assert.equal(await held("ca-water-shutoff"), "Just to check: was the unpaid water bill due on September 3? Say yes, or give me the date.");
    // Two days said, neither taken back: the decoder's is read back, never counted from directly.
    for (const reply of ["the notice says September 3 but I got it September 5", "it was September 3 or 4"])
      for (const setup of [DATE, STOP]) { const r = await at(setup, reply); assert.match(r.say, /^Just to check: was the 3-day notice handed to you on September [345]\?/, reply); assert.equal(r.d.awaiting, "date"); }
    // X8: "<date> was a mistake / is a mistake / was wrong / was incorrect" take the date back.
    const HEARD = (r, reply) => assert.match(r.say, /^Just to check: .* on September 3\? Say yes, or give me the date\.$/, reply);
    for (const reply of ["September 3 was a mistake", "September 3 is a mistake", "September 3 was wrong", "September 3 was incorrect"]) {
      for (const setup of [DATE, STOP]) asked(await at(setup, reply), reply);
      assert.match((await at(SIXTY, reply)).say, /^Okay, about a 60-day notice to move out\. What date is on it\?/, reply);
    }
    // X9: a plan said with an explicit date is read back, not counted from.
    for (const reply of ["I plan to collect the notice on September 3", "I'll pick it up on September 3", "I'm getting it September 3"])
      for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), reply);
    // X10: a receipt verb inside a plan or a wish isn't a receipt; a past receipt still counts.
    // (Never counted: the check, or the date asked again; only the check's plain yes gives a deadline.)
    const notCounted = (r, reply) => { assert.equal(r.d.awaiting, "date", reply); assert.equal(r.done, false, reply); assert.match(r.say, /^(Just to check: |I still need the date|Okay[.,] )/, reply); };
    for (const reply of ["I hope to have it delivered today", "it should be delivered today", "it will be served today"])
      for (const setup of [DATE, STOP, SIXTY]) notCounted(await at(setup, reply), reply);
    // W-c: "today" with a receipt is read back (only a bare "today" counts directly); its yes counts from it.
    for (const reply of ["it was delivered today", "they delivered it today", "they served it today", "they left it on my door today"]) {
      for (const setup of [DATE, STOP]) {
        assert.equal((await at(setup, reply)).say, CHECK("the 3-day notice", "September 30"), reply);
        assert.match((await at([...setup, reply], "yes")).say, /^Your deadline is Monday, October 5, 2026\./, reply);
      }
      assert.equal((await at(SIXTY, reply)).say, CHECK("the 60-day notice to move out", "September 30"), reply);
    }
    // …"I left it at home today", "I found it today", "I saw it today" aren't receipts: asked again.
    for (const reply of ["I left it at home today", "I found it today", "I saw it today", "I found it yesterday"]) for (const setup of [DATE, STOP, SIXTY]) {
      notCounted(await at(setup, reply), reply);
    }
    // X11: two days kept besides one taken back are read back; one kept day besides one taken back is used directly.
    for (const reply of ["Not September 2; September 3 or September 5", "September 3 or the 5th", "September 3 or September 5"])
      for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), reply);
    for (const setup of [DATE, STOP]) assert.equal((await at(setup, "not September 2, September 3")).say, CHECK("the 3-day notice", "September 3"));
    // X12: the uncertainty family is a hedge: read back.
    for (const reply of ["September 3, if I remember correctly", "I believe September 3", "I want to say September 3", "around September 3", "about September 3",
      "roughly September 3", "September 3 or so", "something like September 3", "approximately September 3", "September 3, give or take", "September 3-ish"])
      for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), reply);
    for (const reply of ["September 3", "it was September 3"]) for (const setup of [DATE, STOP]) assert.match((await at(setup, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    // W-a: at the check, never counted from without a plain yes. A letter named with a no, a goodbye or no yes-word clears
    // the held date and is taken as at the date question; with a plain yes the date counts and the letter is carried.
    for (const reply of ["no, but I also got a summons", "before you say goodbye, I also got a summons", "I also got a summons"]) {
      const r = await at(CHECKED, reply);
      assert.deepEqual([r.say, r.d.date, r.d.awaiting], ["Is it about an eviction, a lawsuit about money, or jury duty?", null, "letter"], reply);
    }
    const ud = await at(CHECKED, "thanks, I also got an eviction summons");
    assert.deepEqual([ud.d.letter, ud.d.date, ud.d.awaiting], ["ca-ud", null, "date"]); assert.match(ud.say, /^Got it: California: court papers for an eviction/);
    const both = await at(CHECKED, "yes, and I also got a summons");
    assert.match(both.say, /^That deadline was Wednesday, September 9, 2026\..*You also mentioned a summons or court papers; tell me about that next\./);
    // W-b: any negation or denial word anywhere with a date: never counted from directly (the check, or asked again when
    // the date is taken back).
    for (const reply of ["September 3 is incorrect", "September 3 was a mistake"]) {
      for (const setup of [DATE, STOP, CHECKED]) asked(await at(setup, reply), reply);
      assert.match((await at(SIXTY, reply)).say, /^Okay, about a 60-day notice to move out\. What date is on it\?/, reply);
    }
    for (const reply of ["September 3, but that's wrong", "September 3, no that's wrong", "September 3, not sure that's it", "September 3, never mind"])
      for (const setup of [DATE, STOP, CHECKED, SIXTY]) HEARD(await at(setup, reply), `${setup.length} → ${reply}`);
    // …and after an answer, "September 3 is not correct" isn't a yes to the offer (the answer is read again, not explained).
    for (const setup of [MORE, TEXT]) assert.doesNotMatch((await at(setup, "September 3 is not correct")).say, /^Here's how I counted|In the real service/);
    // A wish said with a relative day (even with a receipt verb) is never counted from: the check or the date again.
    for (const reply of ["I'm hoping it was delivered yesterday", "I want to know if it was delivered yesterday", "my landlord wants to say it was served yesterday",
      "it was supposed to be delivered yesterday", "I expect it was delivered yesterday", "I was waiting for it, it came yesterday", "I hope it was delivered yesterday", "it should have been delivered yesterday"])
      notCounted(await at(DATE, reply), reply);
    // Rule A: the whitelist, counted directly at the date question, the stop offer and the carried date offer.
    for (const reply of ["September 3", "it was September 3", "on September 3", "the date is September 3", "dated September 3", "I got it on September 3",
      "I received it September 3", "they served it September 3", "it was served on September 3", "it was handed to me September 3", "the landlord gave it to me on September 3"]) {
      for (const setup of [DATE, STOP]) assert.match((await at(setup, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
      assert.match((await at(SIXTY, reply)).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/, reply);
    }
    for (const reply of ["yesterday", "it was yesterday", "I got it yesterday", "today", "it was today"]) assert.match((await at(DATE, reply)).say, /^Your deadline is (Friday, October 2|Monday, October 5), 2026\./, reply);
    // The whitelist set the gates replay: counted directly at the date question, the stop offer, the carried date offer and
    // the check (a bare new date there replaces the held one); a stay request is taken out before the bare test.
    for (const reply of ["September 3", "September 3rd", "the 3rd of September", "it was September 3", "on September 3", "dated September 3", "I got it September 3",
      "they served it on September 3", "the landlord gave it to me on September 3", "please don't hang up, September 3", "yesterday", "it was yesterday"])
      for (const setup of [DATE, STOP, SIXTY, [...DATE, "September 5, thanks"]]) {
        const r = await at(setup, reply);
        assert.match(r.say, /^(That deadline was Wednesday, September 9, 2026|Your deadline is Friday, October 2, 2026|A 60-day notice can't end your tenancy before (Monday, November 2|Saturday, November 28), 2026)/, `${setup.join(" / ")} → ${reply}`);
      }
    // X13: on a letter-naming turn every word is read; a hedge or a denial before the date's clause sends it to the check.
    const first = async (text) => { const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); return d.handle(text); };
    for (const text of ["Maybe, I got a 3 day notice on September 3", "I'm not sure, I got a 3 day notice on September 3", "My 3-day notice dated September 3 is wrong"])
      assert.match((await first(text)).say, /^(Just to check: was the 3-day notice handed to you on September 3\?|I still need the date|Got it: California: a 3-day notice)/, text);
    assert.match((await first("I got a 3 day notice on September 3")).say, /^That deadline was Wednesday, September 9, 2026\./);
    assert.match((await first("I got a letter from Social Security dated September 13th, they denied my disability again")).say, /^Your deadline is/);
    // A hedge before a naming turn's date is read, on a first turn and at the date question.
    for (const text of ["I'm not sure, my 3 day notice is dated September 3", "I'm not sure. My 3 day notice is dated September 3", "not sure, I got a 3 day notice dated September 3",
      "maybe, I got a 3 day notice dated September 3", "I got a 3 day notice, it was due September 3"])
      assert.match((await first(text)).say, /^Just to check: was the 3-day notice handed to you on September 3\?/, text);
    for (const reply of ["I'm not sure, the 3 day notice is dated September 3", "not sure. the 3 day notice is dated September 3", "maybe, the 3 day notice says September 3",
      "September 3, September 5", "I got it September 3, the notice says September 1"]) HEARD(await at(DATE, reply), reply);
    assert.match((await first("I got a 3 day notice to pay rent or quit dated September 3")).say, /^That deadline was Wednesday, September 9, 2026\./);
    assert.match((await at(DATE, "the 3 day notice is dated September 3")).say, /^That deadline was Wednesday, September 9, 2026\./);
    assert.match((await at(["they're turning off my water"], "it was due September 3")).say, /^Most water systems can't shut off your water before Monday, November 2, 2026/);
    // X14: "due" and "printed" are hand-over letters' chat: the check; for a printed-date letter "printed" is plain.
    for (const reply of ["The notice is due September 3", "The date printed on the notice is September 3"]) for (const setup of [DATE, STOP]) notCounted(await at(setup, reply), reply);
    for (const reply of ["it was due September 3", "the date printed on it is September 3"]) for (const setup of [DATE, STOP]) HEARD(await at(setup, reply), reply);
    for (const setup of [DATE, STOP]) assert.match((await at(setup, "yesterday or today")).say, /^Just to check: .* on September 29\? /);   // two relative days
    const ssa = new Dialog(mcp.callTool, { today: "2026-09-30" }); await ssa.handle("I got a letter from Social Security, they denied my disability again");
    assert.match((await ssa.handle("the date printed on it is September 3")).say, /^(Your deadline is|That deadline was)/);
    // X15: a second date of any kind in the reply sends the first to the check.
    for (const reply of ["It was September 3 and yesterday", "September 3, or was it yesterday"]) for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), reply);
    // X16: at the check, a yes with anything more than yes words, thanks or a goodbye isn't a plain yes: the date again.
    for (const reply of ["Yes, that is the due date", "yes, that's when it's due", "yes, the date on it"]) asked(await at(CHECKED, reply), reply);
    // (Ten such yeses, at the 3-day, 30-day and 60-day checks; the hedged yeses too: never a deadline.)
    const TEN = ["Yes, that is the due date", "yes, that's when it's due", "yes, the date on it", "yes, that's the rent due date", "yes, that's the printed date",
      "yes, that's when I paid", "yes, that's the wrong one", "yes, about then", "yes I guess", "yes, I believe so", "sure, I guess", "yeah I think so", "yes, I think so"];
    for (const [setup, held] of [[CHECKED, "3-day"], [["I got a 30 day notice", "September 3, thanks"], "30-day"], [HELD60, "60-day"]])
      for (const reply of TEN) { const r = await at(setup, reply); assert.equal(r.done, false, `${held} → ${reply}`); assert.doesNotMatch(r.say, /deadline|can't end your tenancy/i, `${held} → ${reply}`); }
    // End to end from three entries (a denied date, a thanked date, a paid date): the check, then a yes with more words,
    // is never a deadline.
    for (const entry of ["no thanks, it wasn't September 3", "September 3, thanks", "no thanks, I paid on September 3"])
      for (const reply of TEN) {
        const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 3 day notice");
        assert.match((await d.handle(entry)).say, /^Just to check: was the 3-day notice handed to you on September 3\?/, entry);
        const r = await d.handle(reply); assert.doesNotMatch(r.say, /deadline/i, `${entry} → ${reply}`); assert.equal(r.done, false, `${entry} → ${reply}`);
      }
    for (const setup of [DATE, STOP]) assert.match((await at(setup, "yesterday, today")).say, /^Just to check: /);   // two relative days

    for (const reply of ["yes", "yes, thanks", "yes, bye", "yes it was", "yes, September 3"]) assert.match((await at(CHECKED, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    // X17: a letter named with a yes at the check: the letter's words aside, the rest must still be a plain yes; if it
    // isn't, the date is asked again and the letter carried. "yes, and I also got a summons" counts, then carries.
    for (const [reply, carried] of [["Yes, that is the due date. I also got a 30 day notice.", "ca-30day-notice"], ["yes, but that's the due date, and I also got a summons", "ask:a summons or court papers"]]) {
      const r = await at(CHECKED, reply);
      assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, null, "date"], reply); assert.doesNotMatch(r.say, /deadline/i, reply); assert.ok(r.d.carry.includes(carried), reply);
    }
    const yesAnd = await at(CHECKED, "yes, and I also got a summons");
    assert.match(yesAnd.say, /^That deadline was Wednesday, September 9, 2026\./); assert.deepEqual(yesAnd.d.carry, ["ask:a summons or court papers"]);
    // X17 at all six classes, and end to end from three entries: a named letter with a yes that isn't plain never counts
    // the held date; the letter is carried. "yes, and I also got a summons" counts, then carries.
    const CLASSES = [CHECKED, ["I got a 30 day notice", "September 3, thanks"], HELD60, ["I got eviction papers", "September 3, thanks"],
      ["they're turning off my water", "September 3, thanks"], ["I got a letter from Social Security, they denied my disability again", "September 3, thanks"]];
    for (const setup of CLASSES) {
      for (const reply of ["yes, that's the wrong one, and I also got a summons", "yes, that's when I paid, I also got a 3 day notice"]) {
        const r = await at(setup, reply);
        assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, null, "date"], `${setup[0]} → ${reply}`); assert.doesNotMatch(r.say, /deadline|can't end|shut off your water/i, `${setup[0]} → ${reply}`);
      }
      const ok = await at(setup, "yes, and I also got a summons");
      assert.doesNotMatch(ok.say, /^(Okay\. |I still need|Just to check)/, setup[0]); assert.ok(ok.d.carry.includes("ask:a summons or court papers"), setup[0]);
    }
    for (const entry of ["no thanks, it wasn't September 3", "September 3, thanks", "no thanks, I paid on September 3"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 3 day notice"); await d.handle(entry);
      const r = await d.handle("yes, that's the wrong one, and I also got a summons");
      assert.doesNotMatch(r.say, /deadline/i, entry); assert.deepEqual([d.date, d.carry], [null, ["ask:a summons or court papers"]], entry);
    }
    // The receipt words after a yes count only with a receipt verb; never "due", "paid" or a bare "that's the day".
    for (const reply of ["yes, that's the day I got it", "yes, that's the day they gave it to me"]) assert.match((await at(CHECKED, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    for (const reply of ["yes, that's when I paid", "yes, that's the day"]) asked(await at(CHECKED, reply), reply);
    // X19: a yes followed by plain receipt phrasing still counts; the due date still doesn't.
    for (const reply of ["Yes, that's when I got it", "yes, that's when they handed it to me"]) assert.match((await at(CHECKED, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    asked(await at(CHECKED, "Yes, that is the due date"), "due at the check");
    // X20: "handed it over", "dropped it off" are plain receipts.
    for (const reply of ["They handed it over to me on September 3", "they dropped it off September 3"]) for (const setup of [DATE, STOP]) assert.match((await at(setup, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    // X18: the caller's own sending isn't the day it reached them: the check; a receipt in the third person stays direct.
    for (const reply of ["I sent the notice to my landlord on September 3", "I mailed it to the landlord September 3"]) for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), reply);
    for (const reply of ["they sent it September 3", "it was sent to me September 3", "the landlord mailed it September 3", "I was handed it on September 3"])
      for (const setup of [DATE, STOP]) assert.match((await at(setup, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    // X22: at the check, the caller's own sending isn't a plain yes (the named letter still carried); X23: "sent" by them
    // is a receipt.
    asked(await at(CHECKED, "Yes, I mailed it to my landlord"), "X22");
    const mailed = await at(CHECKED, "Yes, I mailed it to my landlord. I also got a 30 day notice.");
    assert.deepEqual([mailed.d.date, mailed.d.awaiting, mailed.d.carry], [null, "date", ["ca-30day-notice"]]); assert.doesNotMatch(mailed.say, /deadline/i);
    asked(await at(CHECKED, "Yes, I sent it to my landlord"), "X23 own send");
    for (const reply of ["Yes, that's when they sent it to me", "Yes, that's when they handed it to me"]) assert.match((await at(CHECKED, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    const sentAnd = await at(CHECKED, "Yes, that's when they sent it to me, I also have a 30 day notice");
    assert.match(sentAnd.say, /^That deadline was Wednesday, September 9, 2026\./); assert.deepEqual(sentAnd.d.carry, ["ca-30day-notice"]);
    // X21: a sending said the other way round ("received notice from me", "got it from me") goes to the check.
    for (const reply of ["My landlord received notice from me on September 3", "the landlord got it from me September 3"]) for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), reply);
    // X24 (decided, after the legal read): "my notice says <date>" is direct for the 3-day notice (and printed-date
    // letters); for the 30-day, 60-day and sheriff's notices, which commonly print the move-out date, it goes to the check;
    // "dated <date>" stays direct for all of them. "I received it from my landlord on September 3" stays direct.
    for (const setup of [DATE, STOP]) for (const reply of ["My notice says September 3", "the notice says September 3", "I received it from my landlord on September 3"])
      assert.match((await at(setup, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    for (const reply of ["My notice says September 3", "it says September 3"]) HEARD(await at(SIXTY, reply), reply);
    assert.match((await at(SIXTY, "dated September 3")).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/);
    assert.match((await at(SIXTY, "I received it from my landlord on September 3")).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/);
    const sheriff = new Dialog(mcp.callTool, { today: "2026-09-30" }); await sheriff.handle("I got a notice to vacate from the sheriff");
    HEARD({ ...(await sheriff.handle("it says September 3")), d: sheriff }, "sheriff says");
    assert.equal(sheriff.letter, "ca-sheriff-vacate");
    // "Yes, they sent it to me then" is a plain receipt yes; "the landlord received it September 3" is the caller's sending.
    assert.match((await at(CHECKED, "yes, they sent it to me then")).say, /^That deadline was Wednesday, September 9, 2026\./);
    for (const setup of [DATE, STOP]) HEARD(await at(setup, "the landlord received it September 3"), "landlord received");
    // X18c / X22 at the six classes and end to end: the caller's own sending at the check is never a plain yes.
    for (const setup of CLASSES) for (const reply of ["yes, that's when I mailed it", "Yes, I mailed it to my landlord", "Yes, I mailed it to my landlord. I also got a 30 day notice."]) {
      const r = await at(setup, reply);
      assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, null, "date"], `${setup[0]} → ${reply}`); assert.doesNotMatch(r.say, /deadline|can't end|shut off your water/i, `${setup[0]} → ${reply}`);
      if (/30 day/.test(reply) && setup[0] !== "I got a 30 day notice") assert.ok(r.d.carry.includes("ca-30day-notice"), `${setup[0]} → ${reply}`);
    }
    for (const entry of ["no thanks, it wasn't September 3", "September 3, thanks", "no thanks, I paid on September 3"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 3 day notice"); await d.handle(entry);
      const r = await d.handle("yes, that's when I mailed it"); assert.doesNotMatch(r.say, /deadline/i, entry); assert.equal(d.date, null, entry);
    }
    // X25 / X26: the caller's own sending through "have / 've", or in the passive ("received by my landlord"), goes to the
    // check, at the date question, the stop offer and the dated-carry offer, and isn't a plain yes at the check; a receipt
    // said that way ("I have been handed it", "I've received it", "I've got it", "it was received by me") stays direct.
    const SIXTY_DATE = ["I got a 60 day notice"], HELD_60 = [...SIXTY, "September 3, thanks"];
    for (const reply of ["I have sent my landlord notice on September 3", "I've mailed it to the landlord on September 3", "My notice was received by my landlord on September 3", "it was received by the landlord September 3"])
      for (const setup of [DATE, STOP, SIXTY, SIXTY_DATE]) HEARD(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const reply of ["I have been handed it on September 3", "I was handed it September 3", "I've received it September 3", "I have received it on September 3", "I've got it September 3", "it was received September 3", "it was received by me September 3"])
      for (const setup of [DATE, STOP, SIXTY, SIXTY_DATE]) assert.match((await at(setup, reply)).say, /^(That deadline was Wednesday, September 9, 2026|A 60-day notice can't end your tenancy before Monday, November 2, 2026)/, `${setup[0]} → ${reply}`);
    for (const setup of [CHECKED, HELD_60]) {
      for (const reply of ["Yes, I have sent my landlord notice", "yes, I've mailed it to my landlord", "Yes, my notice was received by my landlord"]) asked(await at(setup, reply), `${setup[0]} → ${reply}`);
      asked(await at(setup, "yes, I have it"), `${setup[0]} → yes, I have it`);   // having it isn't its date
    }
    // X25 / X26 for the 3-day, 30-day and 60-day letters at the date question, the stop offer, the dated-carry offer and
    // the check, and end to end from the three entries.
    const THIRTY = ["I got a 30 day notice"], HELD_30 = [...THIRTY, "September 3, thanks"];
    const SENDS = ["I have sent my landlord notice on September 3", "we have sent it September 3", "I've mailed it to the landlord on September 3", "I had mailed it September 3",
      "My notice was received by my landlord on September 3", "it was received by the landlord September 3", "it was delivered to my landlord September 3"];
    for (const reply of SENDS) for (const setup of [DATE, STOP, THIRTY, SIXTY, SIXTY_DATE]) HEARD(await at(setup, reply), `${setup[0]} → ${reply}`);
    const YES_SENDS = ["Yes, I have sent my landlord notice", "yes, I've mailed it to my landlord", "yes, we've sent it", "Yes, my notice was received by my landlord", "yes, it was received by the landlord then"];
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of YES_SENDS) asked(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const entry of ["no thanks, it wasn't September 3", "September 3, thanks", "no thanks, I paid on September 3"]) for (const reply of YES_SENDS) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 3 day notice"); await d.handle(entry);
      const r = await d.handle(reply); assert.doesNotMatch(r.say, /deadline/i, `${entry} → ${reply}`);
    }
    const PLAIN = /^(That deadline was Wednesday, September 9, 2026|A (30|60)-day notice can't end your tenancy before (Saturday, October 3|Monday, November 2), 2026)/;
    for (const reply of ["I have received it on September 3", "it was received September 3", "I received it from my landlord on September 3", "I've got it September 3", "I have been handed it September 3"])
      for (const setup of [DATE, STOP, THIRTY, SIXTY]) assert.match((await at(setup, reply)).say, PLAIN, `${setup[0]} → ${reply}`);
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of ["yes, I have received it", "yes, it was received then", "Yes, that's when they sent it to me", "yes, I've received it", "yes, I've got it"])
      assert.match((await at(setup, reply)).say, PLAIN, `${setup[0]} → ${reply}`);
    // H1: "have" / "has" name a date to act by ("it has to be September 3", "I have to be out by September 3"): the check;
    // "it has September 3 on it", "I have it dated September 3" are plain.
    for (const reply of ["it has to be September 3", "it has to be by September 3", "I have to be out by September 3", "we have to be out September 3", "I have to pay by September 3",
      "it has to be paid by September 3", "they have it as September 3", "has to be September 3 I guess", "I have to get it September 3"])
      for (const setup of [DATE, STOP, SIXTY]) HEARD(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const reply of ["it has to be September 3", "it has to be by September 3"]) { const r = await at(CHECKED, reply); assert.doesNotMatch(r.say, /deadline/i, reply); }
    for (const reply of ["it has September 3 on it", "I have it dated September 3"]) for (const setup of [DATE, STOP]) assert.match((await at(setup, reply)).say, /^That deadline was Wednesday, September 9, 2026\./, reply);
    // "says <date>" for the letters that state a later date of their own: the check (one row each); "dated" stays plain;
    // the water bill's "it was due September 3" stays plain.
    for (const [first, reply] of [["they're turning off my water", "my notice says September 3"], ["they're going to shut off my electricity", "it says September 3"], ["my landlord is raising my rent", "my notice says September 3"],
      ["my landlord is opting out of Section 8", "it says September 3"], ["they repossessed my car", "the notice says September 3"]]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle(first);
      const r = await d.handle(reply); assert.match(r.say, /^Just to check: /, `${d.letter} → ${reply}`);
    }
    assert.match((await at(["they're turning off my water"], "it was due September 3")).say, /^Most water systems can't shut off your water before Monday, November 2, 2026/);
    assert.match((await at(SIXTY_DATE, "dated September 3")).say, /^A 60-day notice can't end your tenancy before Monday, November 2, 2026/);
    // X27: a send verb with a recipient after it in its clause (a recipient noun, or "to <someone>"), whoever the subject
    // and whatever adverbs stand between, is the caller's sending: the check at the first answer, and never a plain yes at
    // the check; "to me / us" (or "me" after the verb) is a receipt; the passive counts only "to <someone>".
    const WATER = ["they're turning off my water"], RENT = ["my landlord is raising my rent"];
    for (const reply of ["I also just sent my landlord notice on September 3", "I then mailed it to my landlord September 3", "I first gave it to the manager on September 3",
      "we finally dropped it at the office September 3", "I also just sent it September 3", "they sent it to my landlord September 3", "it was mailed over to the landlord September 3",
      "they sent my landlord the notice on September 3"])
      for (const setup of [DATE, STOP, THIRTY, SIXTY, SIXTY_DATE, WATER, RENT]) HEARD(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of ["yes, I also just sent my landlord notice", "yes, they sent it to my landlord", "yes, I then mailed it to the landlord"])
      asked(await at(setup, reply), `${setup[0]} → ${reply}`);
    const PLAIN27 = /^(That deadline was Wednesday, September 9, 2026|A (30|60)-day notice can't end your tenancy before (Saturday, October 3|Monday, November 2), 2026|Most water systems can't shut off your water before Monday, November 2, 2026|If the increase is 10 percent or less)/;
    for (const reply of ["they also sent it to me September 3", "they gave me my landlord notice on September 3", "I was handed it by the landlord September 3", "it was handed to me September 3",
      "they mailed it on September 3 and the landlord came by", "I came and they handed it to me on September 3"])   // another clause; another subject
      for (const setup of [DATE, STOP, THIRTY, SIXTY_DATE, WATER, RENT]) assert.match((await at(setup, reply)).say, PLAIN27, `${setup[0]} → ${reply}`);
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of ["yes, they just gave it to me", "yes, they also sent it to me", "yes, the landlord then handed it to me", "yes, they gave me my landlord notice"])
      assert.match((await at(setup, reply)).say, PLAIN, `${setup[0]} → ${reply}`);
    // X28: for the letters that state a later date, "says" and up to five words in the same clause before the date ("says
    // by", "says to be out by") is the check, or the date again, never counted from; "dated" stays plain, the 3-day's "says
    // by" / "says" stay plain (decided), a clause break or more than five words between stay plain, and so does the rent
    // increase one-shot.
    for (const reply of ["My notice says by September 3", "it says before September 3", "it says until September 3", "the notice says to be out by September 3"])
      for (const setup of [DATE, WATER, SIXTY_DATE, RENT]) {
        const r = await at(setup, reply);
        assert.equal(r.done, false, `${setup[0]} → ${reply}`); assert.doesNotMatch(r.say, /deadline|can't end your tenancy|can't shut off|If the increase/i, `${setup[0]} → ${reply}`);
      }
    for (const setup of [WATER, SIXTY_DATE, RENT]) HEARD(await at(setup, "My notice says by September 3"), `${setup[0]} → says by`);
    for (const reply of ["dated September 3", "it says, I got it on September 3", "the notice says it was handed to me by my landlord on September 3"])
      for (const setup of [WATER, SIXTY_DATE, RENT]) assert.match((await at(setup, reply)).say, PLAIN27, `${setup[0]} → ${reply}`);
    assert.match((await at(DATE, "my notice says September 3")).say, /^That deadline was Wednesday, September 9, 2026\./);   // decided
    // A deadline preposition right before the date ("by", "before", "until", "no later than", "on or before", "by the")
    // is a date to act by, for every letter, after "says" or not: the check; for the water bill "says it's due <date>" is
    // its due date (plain), elsewhere not counted; "I got it / it was received / dated <date>" stay plain everywhere.
    const heldAt = (r, m) => { assert.match(r.say, /^Just to check: /, m); assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, "2026-09-03", "date"], m); };
    const counted = (r, m) => { assert.doesNotMatch(r.say, /^Just to check|I still need/, m); assert.equal(r.d.date, "2026-09-03", m); assert.notEqual(r.d.awaiting, "date", m); };
    const SHERIFF = ["I got a notice to vacate from the sheriff"], POWER = ["they're going to shut off my electricity"];
    const LETTERS = [DATE, THIRTY, SIXTY_DATE, SHERIFF, WATER, POWER, RENT];
    for (const setup of LETTERS) for (const reply of ["My notice says by September 3", "my notice says no later than September 3", "it says on or before September 3", "I have to be out by September 3",
      "the notice says to be out by September 3", "it says the shutoff is September 3", "it's by September 3", "the deadline is before the 3rd of September"]) {
      const r = await at(setup, reply);
      assert.equal(r.done, false, `${setup[0]} → ${reply}`); assert.doesNotMatch(r.say, /deadline was|can't end your tenancy|can't shut off|If the increase|^Got it/i, `${setup[0]} → ${reply}`);
    }
    for (const setup of LETTERS) for (const reply of ["My notice says by September 3", "my notice says no later than September 3"]) heldAt(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [THIRTY, SIXTY_DATE, SHERIFF, WATER, POWER, RENT]) for (const reply of ["my notice says it is September 3"]) heldAt(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [DATE, SIXTY_DATE, WATER, RENT]) for (const reply of ["by September 3", "pay by September 3", "I have to be out by September 3", "My notice says by September 3"]) heldAt(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [DATE, SIXTY_DATE, WATER, RENT]) for (const reply of ["on September 3", "it was received by me September 3", "handed to me on September 3"]) counted(await at(setup, reply), `${setup[0]} → ${reply}`);   // "by me" is the agent
    // X29: a comma doesn't end the recipient / agent search; X30: "to me" after a send verb wins over a source noun; X31:
    // a receipt verb between "says" and the date is a receipt.
    for (const setup of [DATE, SIXTY_DATE, WATER]) {
      for (const reply of ["They sent my notice on September 3, to my landlord.", "My notice was mailed on September 3, by me.", "they sent it on September 3 to my landlord", "my notice says by September 3"]) heldAt(await at(setup, reply), `${setup[0]} → ${reply}`);
      for (const reply of ["they sent it to me on September 3,", "They handed my notice from my landlord to me on September 3", "I got my notice from my landlord on September 3",
        "My notice says I received this on September 3", "the notice says it was served on September 3"]) counted(await at(setup, reply), `${setup[0]} → ${reply}`);
    }
    for (const setup of [SIXTY_DATE, WATER]) heldAt(await at(setup, "my notice says September 3"), `${setup[0]} → says`);
    // X32: a verbless fragment after a break (". ; ! ..." or and / but) that starts with to / by / from belongs to the
    // clause before it: not a plain yes at the check, end to end from the three entries; the check at the first answer.
    const FRAGMENTS = ["yes, they sent it; to my landlord", "yes, they sent it. To my landlord.", "yes, they sent it! To my landlord.", "yes, they sent it... to my landlord",
      "yes, they sent it and to my landlord", "yes, they sent it. By me.", "yes, it was mailed. By me.", "yes, it was mailed; by me"];
    const TO_ME_YES = ["yes, they sent it. To me.", "yes. They sent it to me.", "yes, they sent it to me"];
    for (const setup of [CHECKED, HELD_30, HELD_60]) {
      for (const reply of FRAGMENTS) asked(await at(setup, reply), `${setup[0]} → ${reply}`);
      for (const reply of TO_ME_YES) assert.match((await at(setup, reply)).say, PLAIN, `${setup[0]} → ${reply}`);
    }
    for (const entry of ["no thanks, it wasn't September 3", "September 3, thanks", "no thanks, I paid on September 3"]) for (const reply of FRAGMENTS) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 3 day notice"); await d.handle(entry);
      const r = await d.handle(reply); assert.doesNotMatch(r.say, /deadline/i, `${entry} → ${reply}`); assert.equal(d.date, null, `${entry} → ${reply}`);
    }
    for (const setup of [DATE, STOP, THIRTY, SIXTY, SIXTY_DATE]) {
      for (const reply of ["They sent my notice on September 3. To my landlord.", "They sent my notice on September 3! To my landlord.", "They sent my notice on September 3 and to my landlord.",
        "They sent my notice on September 3... to my landlord.", "It was mailed on September 3. By me.",
        "They sent it on September 3, over to my landlord", "It was mailed on September 3, actually by me"]) heldAt(await at(setup, reply), `${setup[0]} → ${reply}`);
      counted(await at(setup, "They sent my notice on September 3. To me."), `${setup[0]} → to me`);
      counted(await at(setup, "They mailed it on September 3. From my landlord we got it."), `${setup[0]} → a fragment with its own subject`);   // a new subject ends the fragment
    }
    // X35: "given" is a receipt after "says" only with an object or "to me" ("I was given September 3" may be "given
    // until"): the check at the letters that state a later date; "given it", "given to me" stay plain, "given until" isn't counted.
    const SUBSIDY = ["my landlord is opting out of Section 8"], REPO = ["they repossessed my car"];
    for (const setup of [THIRTY, SIXTY_DATE, SHERIFF, WATER, POWER, RENT, SUBSIDY, REPO]) {
      heldAt(await at(setup, "My notice says I was given September 3."), `${setup[0]} → given`);
      for (const reply of ["it says I was given it on September 3", "the notice says it was given to me on September 3", "the notice says it was given to me September 3"]) counted(await at(setup, reply), `${setup[0]} → ${reply}`);
      const r = await at(setup, "my notice says I was given until September 3"); assert.deepEqual([r.done, r.d.date, r.d.awaiting], [false, null, "date"], `${setup[0]} → given until`);
    }
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of ["yes, I was given it then", "yes, it was given to me then"]) assert.match((await at(setup, reply)).say, PLAIN, `${setup[0]} → ${reply}`);
    for (const setup of LETTERS) for (const reply of ["I got it September 3", "it was received September 3", "dated September 3"]) counted(await at(setup, reply), `${setup[0]} → ${reply}`);
    counted(await at(WATER, "my notice says it's due September 3"), "water due");
    for (const setup of [DATE, THIRTY, SIXTY_DATE, POWER, RENT]) { const r = await at(setup, "my notice says it's due September 3"); assert.equal(r.d.awaiting, "date", setup[0]); assert.doesNotMatch(r.say, /deadline was|can't end|can't shut off|If the increase/i, setup[0]); }
    // The passive "by me / us / my husband ..." after a send verb is the caller's side sending: the check, and never
    // a plain yes; "to me", "to me by the landlord", "given to me then" stay plain. Any run of adverbs before a send verb.
    for (const setup of [DATE, STOP, THIRTY, SIXTY, SIXTY_DATE]) for (const reply of ["it was mailed by me September 3", "it was sent by us September 3", "it was dropped off by my husband September 3",
      "I only recently mailed it September 3", "we also finally gave it to them September 3", "I also actually even just sent it September 3",
      "I um actually also just mailed it September 3", "I um uh sent it September 3"]) heldAt(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of ["yes, it was mailed by me", "yes, it was sent by my lawyer", "yes, it was dropped off by us"]) asked(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [DATE, STOP, THIRTY, SIXTY_DATE]) for (const reply of ["I was given until September 3", "they've given me till September 3"]) {
      const r = await at(setup, reply); assert.notEqual(r.d.awaiting === "date" ? "held" : r.d.date, "2026-09-03", `${setup[0]} → ${reply}`); assert.doesNotMatch(r.say, /deadline was|can't end/i, `${setup[0]} → ${reply}`); }
    for (const setup of [DATE, STOP, THIRTY, SIXTY_DATE]) for (const reply of ["it was mailed to me September 3", "it was handed to me by the landlord September 3", "it was given to me September 3"]) counted(await at(setup, reply), `${setup[0]} → ${reply}`);
    for (const setup of [CHECKED, HELD_30, HELD_60]) for (const reply of ["yes, it was given to me then", "yes, it was mailed to me"]) counted(await at(setup, reply), `${setup[0]} → ${reply}`);
    // End to end from the three denied entries: "yes, it was mailed by me" is never counted.
    for (const entry of ["no thanks, it wasn't September 3", "September 3, thanks", "no thanks, I paid on September 3"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); await d.handle("I got a 3 day notice"); await d.handle(entry);
      const r = await d.handle("yes, it was mailed by me"); assert.doesNotMatch(r.say, /deadline/i, entry); assert.equal(d.date, null, entry);
    }
    { const d = new Dialog(mcp.callTool, { today: "2026-09-30" });
      assert.match((await d.handle("my landlord says my rent is going up, the notice was handed to me on September 15th")).say, /^If the increase is 10 percent or less/); assert.equal(d.date, "2026-09-15"); }
    // Rule B / C: one row of every family, at the check too, is never counted from (the check or the date again).
    for (const reply of ["no, but I also got a summons", "September 3 is incorrect", "September 3, but that's wrong", "they left it on my door today", "I left it at home today",
      "September 3 was a mistake", "I'll pick it up on September 3", "I'm getting it September 3", "I hope to have it delivered today", "it should be delivered today",
      "Not September 2; September 3 or September 5", "September 3 or the 5th", "September 3, if I remember correctly", "I believe September 3", "around September 3",
      "about September 3", "roughly September 3", "September 3 or so", "something like September 3", "approximately September 3", "September 3, give or take", "September 3-ish",
      "I think September 3", "I want to say September 3", "no, it was September 3"])
      for (const setup of [DATE, STOP, SIXTY, CHECKED]) {
        const r = await at(setup, reply);
        assert.equal(r.done, false, `${setup.length} → ${reply}`);
        assert.doesNotMatch(r.say, /deadline|can't end your tenancy/i, `${setup.length} → ${reply}`);
      }
    // A bare stay request at the check repeats the check with the date held.
    for (const reply of ["please don't hang up", "hold on", "don't hang up"]) {
      const r = await at(CHECKED, reply);
      assert.deepEqual([r.say, r.d.date, r.d.awaiting], ["Okay. Just to check: was the 3-day notice handed to you on September 3? Say yes, or give me the date.", "2026-09-03", "date"], reply);
    }
    // Each plan word alone rules a relative day out, even with a receipt verb in the turn.
    for (const reply of ["I got it today and I need to look for the date", "I got it today and I need to find the date", "I got it today, let me check the date",
      "I got it today, I can call back", "I got it today, I can get back to you", "I got it today, I can tell you later", "I got it today, the date will be on it",
      "I got it today, I'll see", "I got it today, we'll see", "I got it today, I'm going to read it", "I got it today, gonna read it", "I got it today, I plan to read it",
      "I got it today, planning to read it", "I got a call today, I need to collect it", "I got a call today, I need to pick it up"])
      asked(await at(DATE, reply), reply);
    // A relative day said with chat ("my hearing is today") is never counted from directly (the bare rule).
    for (const setup of [DATE, STOP]) notCounted(await at(setup, "my hearing is today"), "bare rule");
    // No check for a letter that has no date to count from: at the go-on offer the sale is taken up as before.
    const sale = await at(["I got a jury summons, plus a notice of trustee's sale"], "I think September 3");
    assert.match(sale.say, /^A Notice of Trustee's Sale prints the date/); assert.equal(sale.d.letter, "ca-foreclosure-sale");
    // X6: the plan words ("plan", "collect", "pick it up") rule a relative day out, with or without a receipt verb.
    for (const reply of ["I plan to get it today", "I'll pick it up today", "I need to collect it today"]) for (const setup of [DATE, STOP]) asked(await at(setup, reply), reply);
    // X6: a relative day is the date only with a past receipt or on its own; a plan to collect it is asked again (with
    // thanks, the goodbye).
    for (const reply of ["I plan to collect the notice today", "I'm picking it up today", "I'll get it from the office today"]) {
      for (const setup of [DATE, STOP, CHECKED]) asked(await at(setup, reply), reply);
      assert.match((await at(SIXTY, reply)).say, /^Okay, about a 60-day notice to move out\. What date is on it\?/, reply);
    }
    assert.equal((await at(DATE, "thanks, I'm picking it up today")).say, `Okay. ${END}`);
    assert.equal((await at(SIXTY, "thanks, I'm picking it up today")).say, DECLINED);
    for (const [reply, want] of [["today", /^Your deadline is Monday, October 5, 2026\./], ["it was yesterday", /^Your deadline is Friday, October 2, 2026\./], ["the landlord gave it to me yesterday", /^Your deadline is Friday, October 2, 2026\./]])
      for (const setup of [DATE, STOP, CHECKED]) assert.match((await at(setup, reply)).say, want, `${setup.length} → ${reply}`);
    // X5 (a safe false reject, kept): a receipt said with a later plan isn't taken.
    asked(await at(DATE, "I received it yesterday, and I'll read it again later"), "X5");
    // X7: every goodbye phrase is a read-back marker too ("that's all", "that is all").
    for (const reply of ["September 3, that's all", "September 3, that is all"])
      for (const [setup, letter] of [...STAGES, [CHECKED, "the 3-day notice"]]) assert.equal((await at(setup, reply)).say, CHECK(letter, "September 3"), `${setup.length} → ${reply}`);
    // B2: a failed detection at the date question or the carried date offer: a goodbye is still a goodbye (no 500).
    for (const mode of ["throw", "undefined"]) for (const setup of [DATE, SIXTY]) for (const reply of ["bye", "thanks", "September 3, thanks"]) {
      const d = new Dialog(mcp.callTool, { today: "2026-09-30" }); for (const t of setup) await d.handle(t);
      d.call = async (name, args) => { if (name === "detect_letter") { if (mode === "throw") throw new Error("engine down"); return undefined; } return mcp.callTool(name, args); };
      assert.equal((await d.handle(reply)).done, true, `${mode} ${setup.length} ${reply}`);
    }
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
