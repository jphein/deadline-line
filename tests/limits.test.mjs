// Guardrails for the public web demo: every conversation holds an AssemblyAI session on a billed key.
// Every test has a timeout, so a guard that stops working fails the suite instead of hanging it.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import WebSocket from "ws";
import { startMcp, fakeStt, fakeTts, TODAY } from "./helpers.mjs";
import { createWeb } from "../src/web.js";
import { demoConfig, demoLimits, clientIp, speechSeconds, MESSAGES } from "../src/limits.js";

const T = { timeout: 8000 };
const cfg = (over = {}) => ({ ...demoConfig({}), speechWps: 1e6, ...over });   // no idle grace unless a test asks
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- the limiter on its own, with an injected clock ----------------------------------------------------------
test("limits: concurrency, per-visitor concurrency, per-visitor hourly cap, and release", T, () => {
  let t = Date.parse("2026-09-29T12:00:00Z");
  const L = demoLimits(cfg({ maxConcurrent: 3, maxPerIp: 2, perIpPerHour: 3 }), () => t);
  const a1 = L.admit("a"), a2 = L.admit("a");
  assert.ok(a1.ok && a2.ok);
  assert.deepEqual(L.admit("a"), { ok: false, reason: "perIpBusy" });   // a already has 2 open
  const b1 = L.admit("b"); assert.ok(b1.ok);
  assert.deepEqual(L.admit("c"), { ok: false, reason: "busy" });         // 3 open overall
  L.release(a1.ticket); L.release(a1.ticket);                            // release is idempotent
  assert.equal(L.stats().active, 2);
  const a3 = L.admit("a"); assert.ok(a3.ok);                             // a's third start this hour
  L.release(a2.ticket); L.release(a3.ticket);
  assert.deepEqual(L.admit("a"), { ok: false, reason: "perIp" });       // a fourth start: over the hourly cap
  t += 3601e3;
  assert.ok(L.admit("a").ok);                                            // an hour later, allowed again
});

test("limits: the daily budget is session time, charged on release, and resets at the UTC day", T, () => {
  let t = Date.parse("2026-09-29T23:50:00Z");
  const L = demoLimits(cfg({ dailyS: 60 }), () => t);
  const s = L.admit("a"); t += 61e3; L.release(s.ticket);                // one 61 s conversation
  assert.equal(L.stats().usedS, 61);
  assert.deepEqual(L.admit("b"), { ok: false, reason: "budget" });
  t += 10 * 60e3;                                                        // past midnight UTC
  assert.ok(L.admit("b").ok);
});

test("limits: audio allowance is real time plus the burst", T, () => {
  let t = 1e6;
  const L = demoLimits(cfg({ paceBurstS: 2 }), () => t);
  const { ticket } = L.admit("a");
  assert.equal(L.audioAllowance(ticket, 16000), 2 * 32000);
  t += 3000;
  assert.equal(L.audioAllowance(ticket, 16000), 5 * 32000);
});

test("limits: /tts per-visitor rate", T, () => {
  let t = 0;
  const L = demoLimits(cfg({ ttsPerIpPerMin: 2 }), () => t);
  assert.ok(L.ttsAllowed("a")); assert.ok(L.ttsAllowed("a"));
  assert.equal(L.ttsAllowed("a"), false);
  assert.ok(L.ttsAllowed("b"));
  t += 61e3;
  assert.ok(L.ttsAllowed("a"));
});

test("clientIp: counts proxy hops from the right, so a forged leftmost entry is ignored", T, () => {
  const req = { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, {}), "127.0.0.1");
  assert.equal(clientIp(req, { TRUST_PROXY: "1" }), "203.0.113.7");
  assert.equal(clientIp(req, { TRUST_PROXY: "2" }), "6.6.6.6");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.1.1.1" } }, { TRUST_PROXY: "1" }), "10.1.1.1");
  assert.ok(speechSeconds("one two three four five six", 2) === 3);
});

// ---- the web demo end to end --------------------------------------------------------------------------------
async function webWith(limitsCfg, { stt } = {}) {
  const mcp = await startMcp();
  const stts = [];
  const { app, attach } = createWeb({
    callTool: mcp.callTool, tts: fakeTts, today: TODAY, limits: demoLimits(cfg(limitsCfg)),
    stt: stt || (() => { const s = fakeStt(); stts.push(s); return s; }),
  });
  const http = app.listen(0, "127.0.0.1"); await new Promise(r => http.once("listening", r)); attach(http);
  const port = http.address().port;
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/listen`), msgs = [];
    ws.on("message", d => msgs.push(JSON.parse(d.toString())));
    ws.on("error", () => {});
    let isClosed = false;
    const closed = new Promise(r => ws.once("close", (code) => { isClosed = true; r(code); }));
    await new Promise(r => ws.once("open", r));
    return { ws, msgs, closed, isClosed: () => isClosed };
  };
  const close = async () => { http.closeAllConnections?.(); await new Promise(r => http.close(r)); await mcp.close(); };
  return { port, open, stts, close };
}

/** A raw WebSocket client that completes the handshake and then sends and receives only what the test says. */
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET /listen HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.once("data", (d) => (String(d).startsWith("HTTP/1.1 101") ? resolve(sock) : reject(new Error(String(d)))));
    sock.on("error", () => {});
  });
}

test("web: a conversation ends itself at the session cap, even while the caller keeps talking", T, async () => {
  const w = await webWith({ sessionMaxS: 0.5, idleS: 60 });
  try {
    const c = await w.open();
    const talk = setInterval(() => c.ws.readyState === 1 && c.ws.send(JSON.stringify({ type: "text", text: "hello" })), 100);
    try { await c.closed; } finally { clearInterval(talk); }
    const last = c.msgs.at(-1);
    assert.equal(last.text, MESSAGES.sessionEnd); assert.equal(last.done, true);
    assert.equal(w.stts[0].closed, true);
  } finally { await w.close(); }
});

test("web: silence ends a conversation at the idle limit, and silent audio frames don't keep it open", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 0.4 });
  try {
    const c = await w.open();
    const frames = setInterval(() => c.ws.readyState === 1 && c.ws.send(Buffer.alloc(640)), 20);   // an open mic, nobody talking
    try { await c.closed; } finally { clearInterval(frames); }
    assert.equal(c.msgs.at(-1).text, MESSAGES.idle);
  } finally { await w.close(); }
});

test("web: typing keeps a conversation open past the idle limit", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 0.4 });
  try {
    const c = await w.open();
    for (let i = 0; i < 4; i++) { await sleep(250); c.ws.send(JSON.stringify({ type: "text", text: "hello" })); }
    assert.equal(c.isClosed(), false);                                  // 1 s of typing, past a 0.4 s idle limit
    c.ws.close(); await c.closed;
  } finally { await w.close(); }
});

test("web: speech (partial transcripts) keeps a conversation open past the idle limit", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 0.4 });
  try {
    const c = await w.open(); await sleep(50);
    for (let i = 0; i < 4; i++) { await sleep(250); w.stts[0].emit("turn", { text: "I got a", final: false }); }
    assert.equal(c.isClosed(), false);                                  // someone is talking: not idle
    await c.closed;                                                     // then they stop, and idle ends the call
    assert.equal(c.msgs.at(-1).text, MESSAGES.idle);
  } finally { await w.close(); }
});

test("web: the idle timer waits while the line is still speaking its reply", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 0.3, speechWps: 20 });   // the greeting's 30 words = 1.5 s
  try {
    const c = await w.open();
    await sleep(900);
    assert.equal(c.isClosed(), false);                                  // still inside the greeting's grace
    await c.closed;                                                     // and then idle ends it
    assert.equal(c.msgs.at(-1).text, MESSAGES.idle);
  } finally { await w.close(); }
});

test("web: mic audio reaches the recognizer", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 60 });
  try {
    const c = await w.open();
    c.ws.send(Buffer.alloc(3200)); await sleep(100);
    assert.equal(w.stts[0].bytes, 3200);
    c.ws.close(); await c.closed;
  } finally { await w.close(); }
});

test("web: audio faster than real time is dropped, not forwarded", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 60, paceBurstS: 1 });
  try {
    const c = await w.open();
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) c.ws.send(Buffer.alloc(32000));          // 20 s of audio, all at once
    await sleep(200);
    const allowed = ((Date.now() - t0) / 1000 + 1.2) * 32000;
    assert.ok(w.stts[0].bytes <= allowed, `${w.stts[0].bytes} forwarded, allowance about ${allowed}`);
    assert.ok(w.stts[0].bytes >= 32000);
    c.ws.close(); await c.closed;
  } finally { await w.close(); }
});

test("web: an oversized frame closes that call, and the server keeps serving", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 60, maxFrameBytes: 16 * 1024 });
  try {
    const c = await w.open();
    c.ws.send(Buffer.alloc(64 * 1024));
    await c.closed;
    assert.equal(w.stts[0].bytes, 0);
    assert.equal(w.stts[0].closed, true);
    const next = await w.open(); await sleep(50);
    assert.equal(next.msgs[0].type, "line");
    next.ws.close(); await next.closed;
  } finally { await w.close(); }
});

test("web: a malformed frame doesn't crash the server", T, async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 60 });
  try {
    const sock = await rawClient(w.port);
    const gone = new Promise(r => sock.once("close", r));
    sock.write(Buffer.from([0xc1, 0x81, 1, 2, 3, 4, 0x41]));          // RSV1 set, no extension negotiated
    await gone;
    const next = await w.open(); await sleep(50);                      // still serving
    assert.equal(next.msgs[0].type, "line");
    next.ws.close(); await next.closed;
  } finally { await w.close(); }
});

test("web: a client that never answers the close is cut off within about 2 s", T, async () => {
  const w = await webWith({ sessionMaxS: 0.2, idleS: 60 });
  try {
    const sock = await rawClient(w.port);                              // reads nothing, answers nothing
    const t0 = Date.now();
    await new Promise(r => sock.once("close", r));
    assert.ok(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
  } finally { await w.close(); }
});

test("web: the busy line while the demo is full, and a slot again once it frees up", T, async () => {
  const w = await webWith({ maxConcurrent: 1, maxPerIp: 5, sessionMaxS: 60, idleS: 60 });
  try {
    const first = await w.open();
    const second = await w.open(); await second.closed;
    assert.deepEqual(second.msgs, [{ type: "line", text: MESSAGES.busy, done: true }]);
    assert.equal(w.stts.length, 1);                                    // no recognizer, so nothing billed, for the refused visitor
    first.ws.close(); await first.closed; await sleep(50);
    const third = await w.open(); await sleep(50);
    assert.equal(third.msgs[0].type, "line"); assert.notEqual(third.msgs[0].text, MESSAGES.busy);
    third.ws.close(); await third.closed;
  } finally { await w.close(); }
});

test("web: one visitor can't hold every slot", T, async () => {
  const w = await webWith({ maxConcurrent: 4, maxPerIp: 1, sessionMaxS: 60, idleS: 60 });
  try {
    const first = await w.open();
    const second = await w.open(); await second.closed;
    assert.equal(second.msgs[0].text, MESSAGES.perIpBusy);
    first.ws.close(); await first.closed;
  } finally { await w.close(); }
});

test("web: when speech-to-text can't start, the slot is freed", T, async () => {
  const w = await webWith({ maxConcurrent: 1, sessionMaxS: 60, idleS: 60 }, { stt: () => { throw new Error("no key"); } });
  try {
    for (let i = 0; i < 2; i++) {                                      // the second would hear "busy" if the first leaked
      const c = await w.open(); await c.closed;
      assert.equal(c.msgs[0].type, "error");
    }
  } finally { await w.close(); }
});

test("web: the daily budget is session time: once spent, the next visitor hears so", T, async () => {
  const w = await webWith({ dailyS: 0.3, sessionMaxS: 0.4, idleS: 60, maxPerIp: 5 });
  try {
    const c = await w.open(); await c.closed;                          // one 0.4 s conversation spends it
    const next = await w.open(); await next.closed;
    assert.deepEqual(next.msgs, [{ type: "line", text: MESSAGES.budget, done: true }]);
  } finally { await w.close(); }
});

test("web: /tts answers 429 past the per-visitor rate", T, async () => {
  const w = await webWith({ ttsPerIpPerMin: 1 });
  try {
    const url = `http://127.0.0.1:${w.port}/tts?text=hello`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 429);
  } finally { await w.close(); }
});
