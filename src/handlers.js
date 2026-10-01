// handlers.js — the browser demo's serverless side, as Web-standard handlers (Request in, Response out; the
// platform's env passed in; no Node imports), shared by the Cloudflare Workers adapter (worker.js) and the
// Vercel one (api/*.js). A function can't hold the audio WebSocket open for a whole call, so the page streams
// its mic straight to AssemblyAI with a temporary token from /api/token (the API key never leaves the function),
// and posts each final transcript to /api/decode, which runs the same Dialog over the same vendored rules.
// The conversation's state rides along with each request, so the functions remember nothing between turns.
// The phone line and the full web demo (neural voice, server-side limits) still run on src/server.js.
import { Dialog, GREETING } from "./dialog.js";
import { AAI_WS_URL, KEYTERMS, streamingQuery } from "./streaming.js";
import { demoConfig, tokenLimits, MESSAGES } from "./limits.js";
import { detectLetter, computeDeadline, listLetterTypes, todayIso, DecoderError } from "../vendor/deadline-decoder-mcp/src/decoder.js";

export const TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
export const TOKEN_TTL_S = 60;       // the token must open its session within this; AssemblyAI allows 1 to 600
export const SAMPLE_RATE = 16000;    // what public/pcm-worklet.js sends
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 16 * 1024, MAX_TRANSCRIPT = 2000;

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The visitor's address, from the header each platform sets itself and a client can't forge there.
 *  Cloudflare sets cf-connecting-ip (x-real-ip is whatever the client sent); Vercel's edge sets x-real-ip and
 *  overwrites x-forwarded-for. */
export const CLIENT_IP = {
  "cloudflare-workers": (headers) => headers.get("cf-connecting-ip") || "unknown",
  vercel: (headers) => headers.get("x-real-ip") || String(headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown",
};

/** The Deadline Decoder tools, called in-process: the functions the MCP server wraps, with its default date
 *  (today in California), returning what the MCP client returns (the structured result, as plain JSON). */
export function localCallTool() {
  const tools = {
    detect_letter: ({ text, today, among, letter_type }) => detectLetter(text, today ?? todayIso(), among ?? [], { letterType: letter_type }),
    compute_deadline: ({ letter_type, notice_date, today }) => computeDeadline(letter_type, notice_date, today ?? todayIso()),
    list_letter_types: () => ({ letter_types: listLetterTypes() }),
  };
  return async (name, args) => {
    if (!Object.hasOwn(tools, name)) throw new Error(`unknown tool: ${name}`);
    return JSON.parse(JSON.stringify(tools[name](args)));
  };
}

const LETTERS = new Set(listLetterTypes().map(t => t.id));
const AWAITING = new Set(["letter", "date", "more", "text", "another"]);

/** The page sends back the state it was given, or anything at all: keep only well-formed fields. */
export function cleanState(s) {
  if (!s || typeof s !== "object") return {};
  const letter = LETTERS.has(s.letter) ? s.letter : null;
  const date = typeof s.date === "string" && ISO_DATE.test(s.date) ? s.date : null;
  let awaiting = AWAITING.has(s.awaiting) ? s.awaiting : null;
  if (awaiting === "more" && !(letter && date)) awaiting = null;     // "how did you count?" needs a deadline
  const candidates = Array.isArray(s.candidates) ? [...new Set(s.candidates.filter(c => LETTERS.has(c)))].slice(0, 5) : [];
  const hoa = s.hoa === true;                                         // the caller said HOA (only a real boolean)
  const hoaSaid = s.hoaSaid === true;                                 // the HOA step already spoken (same)
  // The carried letters: real ids only, at most three. Nothing the page sends is spoken: what's said about them is
  // rebuilt on the server from these ids (a carrySpoken in the state is dropped).
  const carry = Array.isArray(s.carry) ? [...new Set(s.carry.filter(c => LETTERS.has(c)))].slice(0, 3) : [];
  // No text from the page is kept: "last" and "dateQuestion" are rebuilt by Dialog.restore() from the letter and the stage.
  return { letter, date, awaiting, candidates, hoa, hoaSaid, carry };
}

/** /api/decode. GET: the line picks up (the greeting, and a new conversation's state).
 *  POST { transcript, state?, today? }: one caller turn; answers { say, done, state }. */
export function decodeHandlers({ callTool = localCallTool() } = {}) {
  return {
    GET: () => json({ say: GREETING, done: false, state: new Dialog(callTool).snapshot() }),
    async POST(request) {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ error: "That request is too large." }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'Send JSON like {"transcript": "..."}.' }, 400); }
      if (typeof body?.transcript !== "string") return json({ error: "transcript must be a string" }, 400);
      const today = typeof body.today === "string" && ISO_DATE.test(body.today) ? body.today : undefined;
      try {
        const dialog = await Dialog.restore(callTool, cleanState(body.state), { today });
        const r = await dialog.handle(body.transcript.slice(0, MAX_TRANSCRIPT));
        return json({ say: r.say, done: r.done, state: dialog.snapshot() });
      } catch (e) {
        if (e instanceof DecoderError) return json({ error: e.message }, 400);
        console.error("decode:", e);
        return json({ error: "Something went wrong on the line. Please try again." }, 500);
      }
    },
  };
}

/** /api/token. GET: a temporary AssemblyAI streaming token for one call, as the ready-to-open WebSocket URL
 *  (16 kHz PCM16, the same key terms as the server). The session is capped at DEMO_SESSION_MAX_S by AssemblyAI;
 *  tokens per visitor and per day are capped here (see tokenLimits), per function instance. */
export function tokenHandler({ env, fetch: fetchImpl, limits = tokenLimits(demoConfig(env)), ip = CLIENT_IP.vercel }) {
  const get = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const sessionMaxS = Math.min(10800, Math.max(60, Math.round(limits.cfg.sessionMaxS)));   // AssemblyAI's range
  return async function GET(request) {
    const key = env.ASSEMBLYAI_API_KEY;
    if (!key) return json({ error: "Speech-to-text isn't set up here (ASSEMBLYAI_API_KEY is missing). You can type instead." }, 503);
    const verdict = limits.allow(ip(request.headers));
    if (!verdict.ok) return json({ error: MESSAGES[verdict.reason] }, 429);
    const url = new URL(TOKEN_URL);
    url.searchParams.set("expires_in_seconds", String(TOKEN_TTL_S));
    url.searchParams.set("max_session_duration_seconds", String(sessionMaxS));
    let token;
    try {
      const r = await get(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        console.warn(`token: AssemblyAI answered HTTP ${r.status}`);
        return json({ error: `AssemblyAI didn't issue a token (HTTP ${r.status}). You can type instead.` }, 502);
      }
      ({ token } = await r.json());
    } catch (e) {
      // Never e.message: for a malformed key (a stray newline, say) fetch's TypeError quotes the header value.
      console.warn(`token: couldn't reach AssemblyAI: ${e.name}${e.cause?.code ? ` (${e.cause.code})` : ""}`);
      return json({ error: "Couldn't reach AssemblyAI. You can type instead." }, 502);
    }
    if (typeof token !== "string" || !token) return json({ error: "AssemblyAI sent no token. You can type instead." }, 502);
    const q = streamingQuery(SAMPLE_RATE, KEYTERMS);
    q.set("token", token);
    return json({
      url: `${env.AAI_STREAMING_URL || AAI_WS_URL}?${q}`, expires_in_seconds: TOKEN_TTL_S, session_max_s: sessionMaxS,
      idle_s: limits.cfg.idleS, messages: { idle: MESSAGES.idle, sessionEnd: MESSAGES.sessionEnd },
    });
  };
}

/** /api/healthz. The page reads mode ("direct": call AssemblyAI itself); platform says which adapter answered, and
 *  channel (when the deployment sets CHANNEL, as deadline-line-next does) which build. */
export function healthHandler(env, platform) {
  return () => json({ ok: true, stt: env.ASSEMBLYAI_API_KEY ? "assemblyai" : "missing key", mode: "direct", platform,
    ...(env.CHANNEL ? { channel: String(env.CHANNEL) } : {}) });
}

/** The three endpoints on one platform: { "/api/token": { GET }, ... }. Both adapters build them here. */
export function apiRoutes(env, platform) {
  if (!CLIENT_IP[platform]) throw new Error(`unknown platform: ${platform}`);
  return {
    "/api/token": { GET: tokenHandler({ env, ip: CLIENT_IP[platform] }) },
    "/api/decode": decodeHandlers(),
    "/api/healthz": { GET: healthHandler(env, platform) },
  };
}

/** A fetch(request, env) for a host that sends every request through one function (Cloudflare Workers): the
 *  API routes, else the static files (env.ASSETS). Routes are built on the first request, because that's when the
 *  env arrives, and then kept, so the token limits live as long as the isolate. */
export function router(build) {
  let routes = null;
  return async function fetch(request, env) {
    routes ??= build(env);
    const route = routes[new URL(request.url).pathname];
    if (!route) return env.ASSETS.fetch(request);
    const handler = route[request.method];
    return handler ? handler(request) : new Response(null, { status: 405, headers: { allow: Object.keys(route).join(", ") } });
  };
}
