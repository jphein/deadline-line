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
  assert.deepEqual(await r.json(), { say: GREETING, done: false, state: { letter: null, date: null, awaiting: null, last: GREETING, candidates: [], dateQuestion: null } });
});

test("api/decode: a state the page tampered with is cleaned, not trusted", T, async () => {
  assert.deepEqual(cleanState({ letter: "evil", date: "soon", awaiting: "more", last: 7, candidates: ["nope", "jury-summons", "jury-summons"], dateQuestion: 5 }),
    { letter: null, date: null, awaiting: null, last: undefined, candidates: ["jury-summons"], dateQuestion: null });
  assert.deepEqual(cleanState({ letter: "ssa-initial", date: "2026-09-13", awaiting: "more", last: "x".repeat(5000) }).last.length, 2000);
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
