// limits.js — guardrails for a PUBLIC web demo. Every conversation streams audio to AssemblyAI on a
// billed key, so a public URL needs a cap per conversation, a cap on how many run at once, a cap per
// visitor, and a daily budget for the whole demo. All of them are set by environment variables; the
// defaults suit a hackathon demo. Nothing here stores audio or transcripts: only counts and times.

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

export function demoConfig(env = process.env) {
  return {
    sessionMaxS: num(env.DEMO_SESSION_MAX_S, 180),       // the longest one conversation may run
    idleS: num(env.DEMO_IDLE_S, 45),                     // close a conversation after this long with no audio or text
    maxConcurrent: num(env.DEMO_MAX_CONCURRENT, 4),      // conversations at once, across all visitors
    perIpPerHour: num(env.DEMO_SESSIONS_PER_IP_HOUR, 12),// new conversations per visitor per hour
    dailyAudioS: num(env.DEMO_DAILY_AUDIO_S, 7200),      // streamed audio per UTC day, across all visitors
    ttsPerIpPerMin: num(env.DEMO_TTS_PER_IP_MIN, 30),    // /tts requests per visitor per minute
  };
}

export const MESSAGES = {
  busy: "The demo line is busy right now. Please try again in a minute.",
  perIp: "You've reached this demo's limit for the hour. Please try again later.",
  budget: "The demo has used today's listening time. Please try again tomorrow.",
  sessionEnd: "That's the end of this demo call. Refresh the page to start another.",
  idle: "I haven't heard anything for a while, so I'm ending this demo call. Refresh the page to start another.",
};

export function demoLimits(cfg = demoConfig(), now = () => Date.now()) {
  let active = 0;
  let day = "", audioS = 0;
  const starts = new Map();   // ip -> start times (ms) in the last hour
  const tts = new Map();      // ip -> request times (ms) in the last minute
  const utcDay = () => new Date(now()).toISOString().slice(0, 10);
  const rollDay = () => { const d = utcDay(); if (d !== day) { day = d; audioS = 0; } };
  const recent = (map, ip, windowMs) => {
    const t = now(), kept = (map.get(ip) || []).filter(x => t - x < windowMs);
    map.set(ip, kept);
    return kept;
  };

  return {
    cfg,
    /** Admit a new conversation from `ip`, or say why not. The caller must release() an admitted one. */
    admit(ip) {
      rollDay();
      if (audioS >= cfg.dailyAudioS) return { ok: false, reason: "budget" };
      if (active >= cfg.maxConcurrent) return { ok: false, reason: "busy" };
      const mine = recent(starts, ip, 3600e3);
      if (mine.length >= cfg.perIpPerHour) return { ok: false, reason: "perIp" };
      mine.push(now()); active += 1;
      return { ok: true };
    },
    release() { if (active > 0) active -= 1; },
    /** Count streamed PCM16 audio. Returns false once today's budget is spent. */
    addAudio(bytes, sampleRate) {
      rollDay();
      audioS += bytes / (2 * sampleRate);
      return audioS < cfg.dailyAudioS;
    },
    ttsAllowed(ip) {
      const mine = recent(tts, ip, 60e3);
      if (mine.length >= cfg.ttsPerIpPerMin) return false;
      mine.push(now());
      return true;
    },
    stats: () => (rollDay(), { active, audioS: Math.round(audioS), day }),
  };
}

/** The visitor's address. Behind Caddy, trust only the first X-Forwarded-For hop, and only when TRUST_PROXY=1. */
export function clientIp(req, env = process.env) {
  if (env.TRUST_PROXY === "1") {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress || "unknown";
}
