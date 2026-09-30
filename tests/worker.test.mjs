// The Cloudflare Workers adapter: worker.js routes the three API paths to src/handlers.js and everything else to
// the static assets. The handlers' own logic is tested in handlers.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { router, apiRoutes } from "../src/handlers.js";
import worker from "../worker.js";

const T = { timeout: 8000 };
const at = (path, init) => new Request(`https://deadline-line.example.workers.dev${path}`, init);
const fakeAssets = () => {
  const seen = [];
  return { seen, fetch: async (request) => { seen.push(new URL(request.url).pathname); return new Response("asset", { status: 200 }); } };
};

test("router: the three API paths reach their handlers with the env; other paths are static assets", T, async () => {
  const builds = [], calls = [];
  const fake = (name) => async (request) => { calls.push([name, request.method, new URL(request.url).pathname]); return new Response(name); };
  const fetch = router((env) => {
    builds.push(env);
    return { "/api/token": { GET: fake("token") }, "/api/decode": { GET: fake("decode"), POST: fake("decode") }, "/api/healthz": { GET: fake("healthz") } };
  });
  const env = { ASSEMBLYAI_API_KEY: "k", ASSETS: fakeAssets() };
  assert.equal(await (await fetch(at("/api/token"), env)).text(), "token");
  assert.equal(await (await fetch(at("/api/decode", { method: "POST", body: "{}" }), env)).text(), "decode");
  assert.equal(await (await fetch(at("/api/healthz?x=1"), env)).text(), "healthz");
  assert.deepEqual(calls, [["token", "GET", "/api/token"], ["decode", "POST", "/api/decode"], ["healthz", "GET", "/api/healthz"]]);
  assert.equal(builds.length, 1); assert.equal(builds[0], env);        // built once, from the platform's env
  const r = await fetch(at("/api/token", { method: "POST" }), env);
  assert.equal(r.status, 405); assert.equal(r.headers.get("allow"), "GET");
  assert.equal((await fetch(at("/"), env)).status, 200);
  assert.equal((await fetch(at("/api/nope"), env)).status, 200);
  assert.deepEqual(env.ASSETS.seen, ["/", "/api/nope"]);                // not an API route: the assets answer
});

test("worker.js: healthz says cloudflare-workers, decode answers, and token reads the key and cf-connecting-ip", T, async () => {
  const saved = globalThis.fetch, upstream = [];
  globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), auth: init.headers.Authorization }); return Response.json({ token: "tok", expires_in_seconds: 60 }); };
  try {
    const env = { ASSEMBLYAI_API_KEY: "test-key-not-real", DEMO_SESSIONS_PER_IP_HOUR: "1", ASSETS: fakeAssets() };
    const h = await (await worker.fetch(at("/api/healthz"), env)).json();
    assert.deepEqual(h, { ok: true, stt: "assemblyai", mode: "direct", platform: "cloudflare-workers" });
    const hello = await (await worker.fetch(at("/api/decode"), env)).json();
    assert.match(hello.say, /^Deadline Line\./);
    const turn = await worker.fetch(at("/api/decode", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "I was handed eviction papers on the 22nd of September.", state: hello.state, today: "2026-09-26" }) }), env);
    assert.match((await turn.json()).say, /^Your deadline is Wednesday, October 7, 2026\./);
    const tok = (cf, spoof) => worker.fetch(at("/api/token", { headers: { "cf-connecting-ip": cf, "x-real-ip": spoof } }), env);
    const first = await tok("203.0.113.7", "1.1.1.1");
    assert.equal(first.status, 200);
    assert.match((await first.json()).url, /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?.*token=tok/);
    assert.equal(upstream[0].auth, "test-key-not-real");
    assert.equal((await tok("203.0.113.7", "9.9.9.9")).status, 429);    // DEMO_SESSIONS_PER_IP_HOUR from the env, keyed on cf-connecting-ip
    assert.equal((await worker.fetch(at("/"), env)).status, 200);
    assert.deepEqual(env.ASSETS.seen, ["/"]);
  } finally { globalThis.fetch = saved; }
});

test("wrangler.toml: --env next is a second Worker, deadline-line-next, that says so in healthz", async () => {
  const toml = await fs.readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^\[env\.next\]\nname = "deadline-line-next"$/m);
  assert.match(toml, /^\[env\.next\.vars\]\nCHANNEL = "next"$/m);
  const r = await router((env) => apiRoutes(env, "cloudflare-workers"))(at("/api/healthz"), { CHANNEL: "next", ASSETS: fakeAssets() });
  assert.deepEqual(await r.json(), { ok: true, stt: "missing key", mode: "direct", platform: "cloudflare-workers", channel: "next" });
});

test("wrangler.toml: worker.js with public/ as the ASSETS binding, and no secret in it", async () => {
  const toml = await fs.readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^main = "worker\.js"$/m);
  assert.match(toml, /^\[assets\]\ndirectory = "public"\nbinding = "ASSETS"$/m);
  assert.doesNotMatch(toml, /^\s*ASSEMBLYAI_API_KEY\s*=/m);
  assert.doesNotMatch(toml, /^\s*account_id/m);
});
