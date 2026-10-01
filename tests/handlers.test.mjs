// The serverless handlers (src/handlers.js) and their Vercel adapter (api/*.js). The Cloudflare Workers adapter
// is in worker.test.mjs. No network: AssemblyAI's token endpoint is a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dialog, GREETING } from "../src/dialog.js";
import { AAI_WS_URL, KEYTERMS, streamingQuery } from "../src/streaming.js";
import { demoConfig, tokenLimits, MESSAGES } from "../src/limits.js";
import { decodeHandlers, tokenHandler, healthHandler, cleanState, CLIENT_IP, TOKEN_URL, TOKEN_TTL_S } from "../src/handlers.js";
import * as decodeApi from "../api/decode.js";
import * as tokenApi from "../api/token.js";
import * as healthApi from "../api/healthz.js";
import { startMcp, TODAY } from "./helpers.mjs";

const T = { timeout: 8000 };
const req = (path, { body, headers = {} } = {}) => new Request(`https://demo.example${path}`, body === undefined ? { headers } :
  { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Talk to /api/decode the way the page does: send each turn with the state the last reply carried. */
async function converse(POST, turns, today = TODAY) {
  let state; const out = [];
  for (const transcript of turns) {
    const r = await POST(req("/api/decode", { body: { transcript, state, today } }));
    assert.equal(r.status, 200);
    const j = await r.json(); state = j.state; out.push({ say: j.say, done: j.done });
  }
  return out;
}

// ---- /api/decode -------------------------------------------------------------------------------------------
test("api/decode answers turn for turn what the phone line answers (same Dialog; rules in-process, not over MCP)", T, async () => {
  const mcp = await startMcp();
  try {
    const scripts = [
      ["I got a letter from Social Security dated September 13th, they denied my disability again", "yes please", "no thanks"],
      ["I got a letter from Social Security dated September 13th, they denied my disability again", "how did you count?", "yes", "thanks"],
      ["I got eviction papers.", "What do you mean?", "They were handed to me on the 22nd of September.", "can you repeat that", "no, goodbye"],
      ["hi, I got some kind of letter and I'm worried", "can you repeat that", "My landlord taped a three day notice on my door yesterday."],
      ["The county says my CalFresh is stopping. The notice is dated September 1st.", "no"],
      ["I got a summons", "it's for jury duty", "no"],
      ["I got court papers", "a debt collector, about money", "September 21st", "how did you count?", "no thanks"],
      ["I got a jury summons", "yes", "My landlord taped a three day notice on my door yesterday."],
      ["I got a summons", "I don't know", "it's from my landlord", "the 22nd of September"],
      ["I got a letter from the IRS", "the notice of deficiency", "it was mailed September 15th", "how did you count?", "no"],
      ["my landlord says my rent is going up, the notice was handed to me on September 15th", "yes"],
      ["Social Security says they overpaid me, the letter is dated September 13th", "no thanks"],
      ["I got a parking ticket on September 20th", "explain", "no"],
      ["they're turning off my water", "the due date was August 1st", "no"],
      ["EDD stopped my disability payments", "the notice is dated September 15th", "no"],
      ["a debt collector sent me a letter", "no"],
      ["social security denied me again and my hearing is scheduled", "not yet", "the notice is dated September 13th", "no"],
      ["social security denied me again and my hearing is scheduled", "yes, I already had it", "the decision is dated September 13th", "no"],
      ["I got a notice of default on my house", "no"],
      ["they're suing me in small claims", "no"],
      ["I got a notice of trustee's sale", "no"],
      ["my HOA sent a notice of default", "no"],
      ["the HOA is auctioning my condo for unpaid assessments", "no"],
      ["my homeowners association sent a notice of trustee's sale", "no"],
      ["my HOA sent me a letter", "a notice of default", "no"],
      ["I got a notice of default on my house", "it's from my HOA", "no"],
      ["I got a 3 day notice", "no", "no", "no", "September 28"],
      ["I got a 3 day notice", "no", "no", "say that again", "yes"],
      ["I got a notice of default on my house", "it's from my HOA", "it's from my HOA", "no"],
      ["my HOA sent a notice of default", "it's from my HOA", "no"],
      ["my friend Hoa helped me read the notice of default on my house", "no"],
      ["the collection agency is suing me, I also got a 3 day notice", "September 28", "yes", "no", "September 25"],
      ["the collection agency is suing me, I also got a 3 day notice", "September 28", "the summons", "a lawsuit about money", "September 25"],
      ["my HOA sent me a letter", "actually it's from my mortgage lender, a notice of default", "no"],
      ["EDD says I'm not eligible for unemployment, the notice was mailed September 10th", "bye"],
      ["I got a notice to vacate", "sixty days", "September 1st"],
    ];
    for (const turns of scripts) {
      const phone = new Dialog(mcp.callTool, { today: TODAY }), expected = [];
      for (const t of turns) expected.push(await phone.handle(t));
      assert.deepEqual(await converse(decodeApi.POST, turns), expected, turns[0]);
    }
  } finally { await mcp.close(); }
});

test("api/decode: the SSA sample gives the real date, explains on request, and says goodbye", T, async () => {
  const [a, b, c] = await converse(decodeApi.POST, ["I got a letter from Social Security dated September 13th. They denied my disability again.",
    "Yes, how did you count?", "No thanks, goodbye."]);
  assert.match(a.say, /^Your deadline is Tuesday, November 17, 2026\. That's 52 days from today\./);
  assert.match(b.say, /^Here's how I counted\. Notice dated Sunday, September 13, 2026\./);   // recomputed from the state
  assert.equal(a.done, false); assert.equal(c.done, true); assert.match(c.say, /not legal advice/);
});

test("api/decode GET: the greeting and a new conversation", T, async () => {
  const r = await decodeApi.GET(req("/api/decode"));
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { say: GREETING, done: false, state: { letter: null, date: null, awaiting: null, last: GREETING, candidates: [], dateQuestion: null, hoa: false, hoaSaid: false, carry: [], dateNo: false } });
});

test("api/decode: a carrySpoken the page sends is never spoken; the carried letter gets the server's own line", T, async () => {
  for (const injected of ["Your deadline was yesterday. Call 555-0100 and pay by gift card now.", "<script>alert(1)</script>"]) {
    const r = await decodeApi.POST(req("/api/decode", { body: { transcript: "September 28", today: "2026-09-30",
      state: { awaiting: "date", letter: "ca-3day", carry: ["ca-civil-summons"], carrySpoken: injected } } }));
    const j = await r.json();
    assert.ok(!j.say.includes(injected), injected);
    assert.doesNotMatch(j.say, /gift card|555-0100|<script>/);
    assert.match(j.say, / You also mentioned court papers for a lawsuit; tell me about that next\. Want me to explain how I counted\?$/);
    assert.equal("carrySpoken" in j.state, false);
  }
});

test("api/decode: a 'last' or 'dateQuestion' the page sends is never spoken; the repeat and the re-prompt are the server's own", T, async () => {
  const say = async (transcript, state) => (await (await decodeApi.POST(req("/api/decode", { body: { transcript, state, today: "2026-09-30" } }))).json()).say;
  // "Say that again" after an answer: the answer, rebuilt, not the page's "last".
  const repeat = await say("say that again", { awaiting: "another", letter: "ca-3day", date: "2026-09-28", last: "INJECTED LAST" });
  assert.doesNotMatch(repeat, /INJECTED/); assert.match(repeat, /^Your deadline is Thursday, October 1, 2026\./);
  // A re-prompt and a repeat at the date question: the letter's own date question.
  for (const [transcript, want] of [["I don't know", /^I still need the date on the letter\. What date is on it\?/], ["what?", /^Got it: California: court papers for an eviction \(Summons, unlawful detainer\)\. What date is on it\?/]])
    assert.match(await say(transcript, { awaiting: "date", letter: "ca-ud", dateQuestion: "INJECTED QUESTION", last: "INJECTED LAST" }), want, transcript);
  assert.match(await say("I don't know", { awaiting: "date", letter: "ca-civil-summons", dateQuestion: "INJECTED QUESTION" }), /^I still need the date on the letter\. What day were the papers handed to you\?/);
  // The normal repeat through the page is what the line said.
  const turns = await converse(decodeApi.POST, ["I got a 3 day notice dated September 28", "say that again"], "2026-09-30");
  assert.equal(turns[1].say, turns[0].say);
  const counted = await converse(decodeApi.POST, ["I got a 3 day notice dated September 28", "yes", "say that again"], "2026-09-30");
  assert.match(counted[1].say, /^Here's how I counted\./); assert.equal(counted[2].say, counted[1].say);
  // A repeat after an answer is the answer rebuilt from validated fields; it includes the HOA step exactly when the step
  // was said for this letter (hoaSaid).
  const STEP = /If your homeowners association is foreclosing/;
  const hoa = await converse(decodeApi.POST, ["my HOA sent a notice of default", "say that again"], "2026-09-30");
  assert.match(hoa[0].say, STEP); assert.equal(hoa[1].say, hoa[0].say);
  const plain = await converse(decodeApi.POST, ["I got a notice of default on my house", "say that again"], "2026-09-30");
  assert.doesNotMatch(plain[1].say, STEP); assert.equal(plain[1].say, plain[0].say);
  // Content-faithful, not verbatim: when the step was said in its own turn ("it's from my HOA" after the answer), the
  // repeat is the whole answer with the step in it, not that turn's words. A verbatim replay would need a new stage
  // field in the page's state, which this doesn't add.
  const later = await converse(decodeApi.POST, ["I got a notice of default on my house", "it's from my HOA", "say that again"], "2026-09-30");
  assert.match(later[1].say, /^If your homeowners association is foreclosing/);
  assert.match(later[2].say, /^A Notice of Default starts the foreclosure clock/); assert.match(later[2].say, STEP);
  const asked = await converse(decodeApi.POST, ["I got a summons", "say that again"], "2026-09-30");
  assert.equal(asked[1].say, asked[0].say);
});

test("api/decode: a tampered stage without the date it needs gets the greeting, not an error", T, async () => {
  const post = async (transcript, state) => decodeApi.POST(req("/api/decode", { body: { transcript, state, today: "2026-09-30" } }));
  for (const state of [{ awaiting: "another", letter: "ca-3day" }, { awaiting: "text", letter: "ca-3day" }]) {
    const r = await post("say that again", state);
    assert.equal(r.status, 200, JSON.stringify(state)); assert.equal((await r.json()).say, GREETING, JSON.stringify(state));
  }
  const yes = await post("yes", { awaiting: "text", letter: "ca-3day" });
  assert.equal(yes.status, 200); assert.match((await yes.json()).say, /^I still need the date on the letter\./);
  // A letter with no date to ask for still repeats its answer at "another".
  assert.match((await (await post("say that again", { awaiting: "another", letter: "ca-foreclosure-nod" })).json()).say, /^A Notice of Default starts the foreclosure clock/);
});

test("api/decode: a state the page tampered with is cleaned, not trusted", T, async () => {
  assert.deepEqual(cleanState({ letter: "evil", date: "soon", awaiting: "more", last: 7, candidates: ["nope", "jury-summons", "jury-summons"], dateQuestion: 5 }),
    { letter: null, date: null, awaiting: null, candidates: ["jury-summons"], hoa: false, hoaSaid: false, carry: [], dateNo: false });
  // Only a real boolean true survives as the HOA flag.
  for (const [v, want] of [[true, true], ["yes", false], [1, false], [{}, false], [undefined, false]]) assert.equal(cleanState({ hoa: v }).hoa, want, String(v));
  for (const [v, want] of [[true, true], ["yes", false], [1, false], [{}, false], [undefined, false]]) assert.equal(cleanState({ hoaSaid: v }).hoaSaid, want, String(v));
  // The carried letters: real ids only, at most three.
  assert.deepEqual(cleanState({ carry: ["ca-3day", "nope", "ca-3day", "ca-ud", "jury-summons", "ca-noa"] }).carry, ["ca-3day", "ca-ud", "jury-summons"]);
  assert.deepEqual(cleanState({ carry: "ca-3day" }).carry, []);
  for (const [v, want] of [[true, true], ["yes", false], [1, false], [undefined, false]]) assert.equal(cleanState({ dateNo: v }).dateNo, want, String(v));
  // A carrySpoken in the state is dropped: the line about a carried letter is the server's own.
  assert.equal("carrySpoken" in cleanState({ carry: ["ca-civil-summons"], carrySpoken: "INJECTED TEXT" }), false);
  // No text from the page is kept: "last" and "dateQuestion" are rebuilt on the server.
  const cleaned = cleanState({ letter: "ssa-initial", date: "2026-09-13", awaiting: "more", last: "INJECTED LAST", dateQuestion: "INJECTED QUESTION" });
  assert.equal("last" in cleaned, false); assert.equal("dateQuestion" in cleaned, false);
  assert.deepEqual(cleanState("nope"), {});
  const r = await decodeApi.POST(req("/api/decode", { body: { transcript: "yes", state: { letter: "x", awaiting: "more", result: { how_we_counted_spoken: "lies" } }, today: TODAY } }));
  assert.equal(r.status, 200);
  assert.doesNotMatch((await r.json()).say, /lies/);
});

test("api/decode: bad requests get a 4xx, not a crash", T, async () => {
  const { POST } = decodeHandlers();
  assert.equal((await POST(req("/api/decode", { body: "{not json" }))).status, 400);
  assert.equal((await POST(req("/api/decode", { body: { state: {} } }))).status, 400);                 // no transcript
  assert.equal((await POST(req("/api/decode", { body: { transcript: "x".repeat(20000) } }))).status, 413);
  const bad = await POST(req("/api/decode", { body: { transcript: "Social Security denied me, the letter is dated September 13th", today: "2026-02-31" } }));
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /not a real calendar date/);
  const ignored = await POST(req("/api/decode", { body: { transcript: "hello", today: "tomorrow" } }));   // not a date: ignored
  assert.equal(ignored.status, 200);
});

// ---- /api/token --------------------------------------------------------------------------------------------
/** A fake AssemblyAI token endpoint that records each request. */
function fakeTokenFetch(reply = () => Response.json({ token: "tok-123", expires_in_seconds: TOKEN_TTL_S })) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: new URL(url), auth: init?.headers?.Authorization }); return reply(); };
  return { calls, fetch };
}
const KEY = "test-key-not-real";
const token = (over = {}, cfgOver = {}, now) => {
  const f = fakeTokenFetch(over.reply);
  const GET = tokenHandler({ env: { ASSEMBLYAI_API_KEY: KEY }, fetch: f.fetch, limits: tokenLimits({ ...demoConfig({}), ...cfgOver }, now) });
  return { GET, calls: f.calls };
};

test("api/token: a 60 s token for a session AssemblyAI ends at the demo's cap, as a ready WebSocket URL", T, async () => {
  const { GET, calls } = token();
  const r = await GET(req("/api/token", { headers: { "x-real-ip": "203.0.113.5" } }));
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const text = await r.text();
  assert.ok(!text.includes(KEY), "the API key never reaches the page");
  const j = JSON.parse(text);
  assert.equal(calls.length, 1);
  assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, TOKEN_URL);
  assert.equal(calls[0].auth, KEY);
  assert.equal(calls[0].url.searchParams.get("expires_in_seconds"), "60");
  assert.equal(calls[0].url.searchParams.get("max_session_duration_seconds"), "180");
  const ws = new URL(j.url);
  assert.equal(`${ws.protocol}//${ws.host}${ws.pathname}`, AAI_WS_URL);
  assert.equal(ws.searchParams.get("token"), "tok-123");
  ws.searchParams.delete("token");
  assert.equal(ws.searchParams.toString(), streamingQuery(16000, KEYTERMS).toString());   // what the server's sessions use
  assert.deepEqual(JSON.parse(ws.searchParams.get("keyterms_prompt")), KEYTERMS);
  assert.deepEqual({ ...j, url: undefined }, { url: undefined, expires_in_seconds: 60, session_max_s: 180, idle_s: 45,
    messages: { idle: MESSAGES.idle, sessionEnd: MESSAGES.sessionEnd } });
});

test("api/token: without a key it says so, and never calls AssemblyAI", T, async () => {
  const f = fakeTokenFetch();
  const r = await tokenHandler({ env: {}, fetch: f.fetch })(req("/api/token"));
  assert.equal(r.status, 503); assert.match((await r.json()).error, /ASSEMBLYAI_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test("api/token: AssemblyAI refusing, failing or sending no token is a 502 that leaks nothing", T, async () => {
  for (const reply of [() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }), () => { throw new TypeError("fetch failed"); },
    () => Response.json({ nope: true })]) {
    const { GET } = token({ reply });
    const r = await GET(req("/api/token", { headers: { "x-real-ip": "198.51.100.7" } }));
    assert.equal(r.status, 502);
    const text = await r.text();
    assert.ok(!text.includes(KEY)); assert.match(JSON.parse(text).error, /You can type instead/);
  }
});

test("api/token: a malformed key never reaches the logs, though fetch's error message quotes it", T, async () => {
  const bad = "not-a-key\r\nX-Leak: yes", logged = [], warn = console.warn;
  console.warn = (...a) => logged.push(a.join(" "));
  try {
    // new Request() validates headers exactly as fetch() does, with no network: a TypeError that quotes the value
    const GET = tokenHandler({ env: { ASSEMBLYAI_API_KEY: bad }, fetch: async (url, init) => new Request(url, init) });
    const r = await GET(req("/api/token"));
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes("not-a-key"));
  } finally { console.warn = warn; }
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("not-a-key"), logged[0]);
  assert.match(logged[0], /TypeError/);
});

test("api/token: per-visitor hourly cap (x-real-ip), then allowed again an hour later", T, async () => {
  let t = Date.parse("2026-09-29T20:00:00Z");
  const { GET, calls } = token({}, { perIpPerHour: 2 }, () => t);
  const as = (ip) => GET(req("/api/token", { headers: { "x-real-ip": ip } }));
  assert.equal((await as("a")).status, 200); assert.equal((await as("a")).status, 200);
  const third = await as("a");
  assert.equal(third.status, 429); assert.equal((await third.json()).error, MESSAGES.perIp);
  assert.equal((await as("b")).status, 200);                       // someone else isn't affected
  assert.equal(calls.length, 3);                                   // the refused request never reached AssemblyAI
  t += 3600e3;
  assert.equal((await as("a")).status, 200);
});

test("api/token: a daily cap of tokens (daily budget / session cap), reset at the UTC day", T, async () => {
  let t = Date.parse("2026-09-29T20:00:00Z");
  const { GET } = token({}, { dailyS: 360, sessionMaxS: 180 }, () => t);         // 2 tokens a day
  const as = (ip) => GET(req("/api/token", { headers: { "x-real-ip": ip } }));
  assert.equal((await as("a")).status, 200); assert.equal((await as("b")).status, 200);
  const r = await as("c");
  assert.equal(r.status, 429); assert.equal((await r.json()).error, MESSAGES.budget);
  t = Date.parse("2026-09-30T00:00:01Z");
  assert.equal((await as("c")).status, 200);
});

test("api/token: the session cap stays inside AssemblyAI's 60 to 10800 s", T, async () => {
  for (const [s, want] of [[30, "60"], [99999, "10800"], [240, "240"]]) {
    const { GET, calls } = token({}, { sessionMaxS: s });
    await GET(req("/api/token"));
    assert.equal(calls[0].url.searchParams.get("max_session_duration_seconds"), want);
  }
});

test("the visitor's address comes from the header each platform sets: x-real-ip on Vercel, cf-connecting-ip on Workers", () => {
  const vercel = CLIENT_IP.vercel, workers = CLIENT_IP["cloudflare-workers"];
  assert.equal(vercel(new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })), "203.0.113.9");
  assert.equal(vercel(new Headers({ "x-forwarded-for": "198.51.100.1, 10.1.1.1" })), "198.51.100.1");
  assert.equal(vercel(new Headers()), "unknown");
  // On Cloudflare a client can send any x-real-ip; only cf-connecting-ip is Cloudflare's own
  assert.equal(workers(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-real-ip": "1.2.3.4" })), "203.0.113.9");
  assert.equal(workers(new Headers({ "x-real-ip": "1.2.3.4" })), "unknown");
});

test("api/token: the per-visitor cap follows the platform's own address header", T, async () => {
  const f = fakeTokenFetch();
  const GET = tokenHandler({ env: { ASSEMBLYAI_API_KEY: KEY }, fetch: f.fetch, ip: CLIENT_IP["cloudflare-workers"],
    limits: tokenLimits({ ...demoConfig({}), perIpPerHour: 1 }) });
  const as = (cf, spoof) => GET(req("/api/token", { headers: { "cf-connecting-ip": cf, "x-real-ip": spoof } }));
  assert.equal((await as("203.0.113.1", "1.1.1.1")).status, 200);
  assert.equal((await as("203.0.113.1", "2.2.2.2")).status, 429);     // a new x-real-ip doesn't make a new visitor
  assert.equal((await as("203.0.113.2", "2.2.2.2")).status, 200);
});

test("api/token: AAI_STREAMING_URL in the env points the page at another endpoint (a rehearsal stand-in)", T, async () => {
  const f = fakeTokenFetch();
  const r = await tokenHandler({ env: { ASSEMBLYAI_API_KEY: KEY, AAI_STREAMING_URL: "ws://127.0.0.1:8799/v3/ws" }, fetch: f.fetch })(req("/api/token"));
  assert.match((await r.json()).url, /^ws:\/\/127\.0\.0\.1:8799\/v3\/ws\?/);
});

// ---- the api/ modules as Vercel loads them ------------------------------------------------------------------
test("api/*.js: Web handlers that read the key when a request arrives", T, async () => {
  const saved = { key: process.env.ASSEMBLYAI_API_KEY, fetch: globalThis.fetch };
  try {
    delete process.env.ASSEMBLYAI_API_KEY;
    assert.deepEqual(await (await healthApi.GET(req("/api/healthz"))).json(), { ok: true, stt: "missing key", mode: "direct", platform: "vercel" });
    assert.equal((await tokenApi.GET(req("/api/token"))).status, 503);
    process.env.ASSEMBLYAI_API_KEY = KEY;
    const f = fakeTokenFetch(); globalThis.fetch = f.fetch;
    assert.equal((await healthApi.GET(req("/api/healthz"))).status, 200);
    assert.equal((await (await healthApi.GET(req("/api/healthz"))).json()).stt, "assemblyai");
    const r = await tokenApi.GET(req("/api/token", { headers: { "x-real-ip": "192.0.2.1" } }));
    assert.equal(r.status, 200); assert.equal(f.calls[0].auth, KEY);
    assert.equal(typeof decodeApi.GET, "function"); assert.equal(typeof decodeApi.POST, "function");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.ASSEMBLYAI_API_KEY; else process.env.ASSEMBLYAI_API_KEY = saved.key;
  }
});

test("healthHandler: mode direct, the platform, and whether the key is set", async () => {
  assert.deepEqual(await healthHandler({ ASSEMBLYAI_API_KEY: "k" }, "vercel")().json(), { ok: true, stt: "assemblyai", mode: "direct", platform: "vercel" });
  assert.deepEqual(await healthHandler({}, "cloudflare-workers")().json(), { ok: true, stt: "missing key", mode: "direct", platform: "cloudflare-workers" });
});

test("api/decode: an HOA mentioned on one turn is still heard when the notice is named on the next", T, async () => {
  const out = await converse(decodeApi.POST, ["my HOA sent me a letter", "a notice of default"], "2026-09-30");
  assert.match(out[1].say, / If your homeowners association is foreclosing without going to court over assessments that came due from 2006 on, you may still be able to redeem the home for 90 days after the sale, and the notice of sale is supposed to mention that right\. Ask legal aid right away\. /);
  const plain = await converse(decodeApi.POST, ["I got a letter", "a notice of default"], "2026-09-30");
  assert.ok(!plain[1].say.includes("homeowners association"));
  // Said once per letter, across turns carried only in the page's state.
  const steps = (out) => out.map(o => o.say).join(" ").split("If your homeowners association is foreclosing").length - 1;
  assert.equal(steps(await converse(decodeApi.POST, ["I got a notice of default on my house", "it's from my HOA", "it's from my HOA"], "2026-09-30")), 1);
  assert.equal(steps(await converse(decodeApi.POST, ["my HOA sent a notice of default", "it's from my HOA"], "2026-09-30")), 1);
  // A finished conversation's HOA mention doesn't carry into the next one on the same page.
  assert.equal(steps(await converse(decodeApi.POST, ["my HOA sent me a letter", "goodbye", "I got a notice of default on my house"], "2026-09-30")), 0);
  assert.equal(steps(await converse(decodeApi.POST, ["my HOA sent a notice of default", "no", "I got a notice of default on my house", "it's from my HOA"], "2026-09-30")), 2);
});
