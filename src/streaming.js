// streaming.js — how a Universal-Streaming session is opened, in plain JS with no Node imports, so the Node server
// (src/aai.js) and the serverless handlers (src/handlers.js, on Cloudflare Workers and Vercel) share one definition.
export const AAI_WS_URL = "wss://streaming.assemblyai.com/v3/ws";

/** The query for one streaming session: raw PCM16, formatted turns, key terms. */
export function streamingQuery(sampleRate, keyterms = []) {
  const q = new URLSearchParams({ sample_rate: String(sampleRate), encoding: "pcm_s16le", format_turns: "true" });
  if (keyterms.length) q.set("keyterms_prompt", JSON.stringify(keyterms));
  return q;
}

// Words the recognizer should expect on this line (boosts accuracy on legal/benefits vocabulary).
export const KEYTERMS = ["Social Security", "reconsideration", "unlawful detainer", "summons", "three day notice",
  "eviction", "Medi-Cal", "CalFresh", "Notice of Action", "SSI", "disability", "landlord"];
