// limits.js — guardrails for a PUBLIC web demo. Every conversation opens an AssemblyAI streaming session on
// a billed key, so a public URL needs a cap per conversation, a cap on how many run at once (overall and per
// visitor), a cap on new conversations per visitor, and a daily budget of session time for the whole demo.
// All of them are set by environment variables; the defaults suit a hackathon demo. Nothing here stores
// audio or transcripts: only counts and times.

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export function demoConfig(env = process.env) {
  return {
    sessionMaxS: num(env.DEMO_SESSION_MAX_S, 180),        // the longest one conversation may run
    idleS: num(env.DEMO_IDLE_S, 45),                      // hang up after this long with no speech, typing or reply
    maxConcurrent: num(env.DEMO_MAX_CONCURRENT, 4),       // conversations at once, across all visitors
    maxPerIp: num(env.DEMO_MAX_PER_IP, 2),                // conversations at once from one visitor
    perIpPerHour: num(env.DEMO_SESSIONS_PER_IP_HOUR, 12), // new conversations per visitor per hour
    dailyS: num(env.DEMO_DAILY_S, 7200),                  // session time per UTC day, across all visitors
    ttsPerIpPerMin: num(env.DEMO_TTS_PER_IP_MIN, 30),     // /tts requests per visitor per minute
    paceBurstS: num(env.DEMO_PACE_BURST_S, 2),            // audio may run this far ahead of real time
    maxFrameBytes: num(env.DEMO_MAX_FRAME_BYTES, 64 * 1024), // largest WebSocket frame accepted
    speechWps: num(env.DEMO_SPEECH_WPS, 2.4),             // words per second the line speaks (for the idle grace)
  };
}

export const MESSAGES = {
  busy: "The demo line is busy right now. Please try again in a minute.",
  perIpBusy: "You already have a call open. Please hang up the other one first.",
  perIp: "You've reached this demo's limit for the hour. Please try again later.",
  budget: "The demo has used today's listening time. Please try again tomorrow.",
  sessionEnd: "That's the end of this demo call. Refresh the page to start another.",
  idle: "I haven't heard anything for a while, so I'm ending this demo call. Refresh the page to start another.",
};

export function demoLimits(cfg = demoConfig(), now = () => Date.now()) {
  let active = 0, day = "", usedS = 0;
  const activeByIp = new Map();  // ip -> conversations open now
  const starts = new Map();      // ip -> start times (ms) in the last hour
  const tts = new Map();         // ip -> /tts request times (ms) in the last minute
  const utcDay = () => new Date(now()).toISOString().slice(0, 10);
  const rollDay = () => { const d = utcDay(); if (d !== day) { day = d; usedS = 0; } };
  const recent = (map, ip, windowMs) => {
    const t = now(), kept = (map.get(ip) || []).filter(x => t - x < windowMs);
    map.set(ip, kept);
    return kept;
  };

  return {
    cfg,
    /** Admit a new conversation from `ip`, or say why not. An admitted one returns a ticket for release(). */
    admit(ip) {
      rollDay();
      if (usedS >= cfg.dailyS) return { ok: false, reason: "budget" };
      if (active >= cfg.maxConcurrent) return { ok: false, reason: "busy" };
      if ((activeByIp.get(ip) || 0) >= cfg.maxPerIp) return { ok: false, reason: "perIpBusy" };
      const mine = recent(starts, ip, 3600e3);
      if (mine.length >= cfg.perIpPerHour) return { ok: false, reason: "perIp" };
      mine.push(now()); active += 1; activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
      return { ok: true, ticket: { ip, start: now(), released: false } };
    },
    /** Close a conversation: free its slots and charge its session time to today's budget. Idempotent. */
    release(ticket) {
      if (!ticket || ticket.released) return;
      ticket.released = true;
      active = Math.max(0, active - 1);
      const n = (activeByIp.get(ticket.ip) || 1) - 1;
      if (n > 0) activeByIp.set(ticket.ip, n); else activeByIp.delete(ticket.ip);
      rollDay();
      usedS += Math.max(0, now() - ticket.start) / 1000;
    },
    /** How many PCM16 bytes a conversation may have streamed by now: real time plus a small burst. */
    audioAllowance(ticket, sampleRate) {
      return Math.floor(((now() - ticket.start) / 1000 + cfg.paceBurstS) * sampleRate * 2);
    },
    ttsAllowed(ip) {
      const mine = recent(tts, ip, 60e3);
      if (mine.length >= cfg.ttsPerIpPerMin) return false;
      mine.push(now());
      return true;
    },
    stats: () => (rollDay(), { active, usedS: Math.round(usedS), day }),
  };
}

/** The visitor's address. Behind N trusted proxies (TRUST_PROXY=N), use the Nth X-Forwarded-For entry from
 *  the right: each proxy appends the address it saw, so entries further left could be forged by the client. */
export function clientIp(req, env = process.env) {
  const hops = Number(env.TRUST_PROXY) || 0;
  if (hops > 0) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
    if (xff.length >= hops) return xff[xff.length - hops];
  }
  return req.socket?.remoteAddress || "unknown";
}

/** Rough speaking time for a reply, so the idle timer doesn't run while the line is still talking. */
export const speechSeconds = (text, wps = 2.4) => String(text || "").split(/\s+/).filter(Boolean).length / wps;
