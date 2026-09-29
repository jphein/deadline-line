// Guardrails for the public web demo: the AssemblyAI key is billed per streamed second.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startMcp, fakeStt, fakeTts, TODAY } from "./helpers.mjs";
import { createWeb } from "../src/web.js";
import { demoConfig, demoLimits, clientIp, MESSAGES } from "../src/limits.js";

const cfg = (over = {}) => ({ ...demoConfig({}), ...over });

test("limits: concurrency, per-visitor hourly cap, and release", () => {
  let t = Date.parse("2026-09-29T12:00:00Z");
  const L = demoLimits(cfg({ maxConcurrent: 2, perIpPerHour: 3 }), () => t);
  assert.deepEqual(L.admit("a"), { ok: true });
  assert.deepEqual(L.admit("b"), { ok: true });
  assert.deepEqual(L.admit("c"), { ok: false, reason: "busy" });
  L.release(); L.release();
  assert.ok(L.admit("a").ok); L.release();
  assert.ok(L.admit("a").ok); L.release();
  assert.deepEqual(L.admit("a"), { ok: false, reason: "perIp" });   // a's fourth start this hour
  t += 3601e3;
  assert.ok(L.admit("a").ok);                                       // an hour later, allowed again
});

test("limits: the daily audio budget stops streaming and resets at the UTC day", () => {
  let t = Date.parse("2026-09-29T23:59:00Z");
  const L = demoLimits(cfg({ dailyAudioS: 2 }), () => t);
  assert.equal(L.addAudio(32000, 16000), true);        // 1 s of 16 kHz PCM16
  assert.equal(L.addAudio(32000, 16000), false);       // 2 s: budget spent
  assert.deepEqual(L.admit("a"), { ok: false, reason: "budget" });
  t += 120e3;                                          // past midnight UTC
  assert.ok(L.admit("a").ok);
  assert.equal(L.stats().audioS, 0);
});

test("limits: /tts per-visitor rate", () => {
  let t = 0;
  const L = demoLimits(cfg({ ttsPerIpPerMin: 2 }), () => t);
  assert.ok(L.ttsAllowed("a")); assert.ok(L.ttsAllowed("a"));
  assert.equal(L.ttsAllowed("a"), false);
  assert.ok(L.ttsAllowed("b"));
  t += 61e3;
  assert.ok(L.ttsAllowed("a"));
});

test("clientIp trusts X-Forwarded-For only when TRUST_PROXY=1", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.7, 10.9.9.9" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, {}), "127.0.0.1");
  assert.equal(clientIp(req, { TRUST_PROXY: "1" }), "203.0.113.7");
});

async function webWith(limitsCfg) {
  const mcp = await startMcp();
  const stts = [];
  const { app, attach } = createWeb({
    callTool: mcp.callTool, stt: () => { const s = fakeStt(); stts.push(s); return s; }, tts: fakeTts, today: TODAY,
    limits: demoLimits(cfg(limitsCfg)),
  });
  const http = app.listen(0, "127.0.0.1"); await new Promise(r => http.once("listening", r)); attach(http);
  const port = http.address().port;
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/listen`), msgs = [];
    ws.on("message", d => msgs.push(JSON.parse(d.toString())));
    const closed = new Promise(r => ws.once("close", r));
    await new Promise(r => ws.once("open", r));
    return { ws, msgs, closed };
  };
  const close = async () => { await new Promise(r => http.close(r)); await mcp.close(); };
  return { port, open, stts, close };
}

test("web: a conversation ends itself at the session cap, and the recognizer is closed", async () => {
  const w = await webWith({ sessionMaxS: 0.3, idleS: 60 });
  try {
    const c = await w.open();
    await c.closed;
    const last = c.msgs.at(-1);
    assert.equal(last.text, MESSAGES.sessionEnd); assert.equal(last.done, true);
    assert.equal(w.stts[0].closed, true);
  } finally { await w.close(); }
});

test("web: silence ends a conversation at the idle limit", async () => {
  const w = await webWith({ sessionMaxS: 60, idleS: 0.3 });
  try { const c = await w.open(); await c.closed; assert.equal(c.msgs.at(-1).text, MESSAGES.idle); }
  finally { await w.close(); }
});

test("web: a second visitor gets the busy line while the demo is full, and gets in once it frees up", async () => {
  const w = await webWith({ maxConcurrent: 1, sessionMaxS: 60, idleS: 60 });
  try {
    const first = await w.open();
    const second = await w.open(); await second.closed;
    assert.deepEqual(second.msgs, [{ type: "line", text: MESSAGES.busy, done: true }]);
    assert.equal(w.stts.length, 1);                     // no recognizer, so nothing billed, for the refused visitor
    first.ws.close(); await first.closed;
    await new Promise(r => setTimeout(r, 50));
    const third = await w.open();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(third.msgs[0].type, "line"); assert.notEqual(third.msgs[0].text, MESSAGES.busy);
    third.ws.close(); await third.closed;
  } finally { await w.close(); }
});

test("web: streaming past the daily audio budget ends the call without sending more audio", async () => {
  const w = await webWith({ dailyAudioS: 0.01, sessionMaxS: 60, idleS: 60 });   // 0.01 s = 320 bytes at 16 kHz
  try {
    const c = await w.open();
    c.ws.send(Buffer.alloc(1000));
    await c.closed;
    assert.equal(c.msgs.at(-1).text, MESSAGES.budget);
    assert.equal(w.stts[0].bytes, 0);
  } finally { await w.close(); }
});

test("web: /tts answers 429 past the per-visitor rate", async () => {
  const w = await webWith({ ttsPerIpPerMin: 1 });
  try {
    const url = `http://127.0.0.1:${w.port}/tts?text=hello`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 429);
  } finally { await w.close(); }
});
