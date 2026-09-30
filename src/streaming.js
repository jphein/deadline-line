// streaming.js — how a Universal-Streaming session is opened, in plain JS with no Node imports, so the Node server
// (src/aai.js) and the serverless handlers (src/handlers.js, on Cloudflare Workers and Vercel) share one definition.
import { KEYTERMS as RULE_TERMS } from "../vendor/deadline-decoder-mcp/src/decoder.js";

export const AAI_WS_URL = "wss://streaming.assemblyai.com/v3/ws";

/** The query for one streaming session: raw PCM16, formatted turns, key terms. */
export function streamingQuery(sampleRate, keyterms = []) {
  const q = new URLSearchParams({ sample_rate: String(sampleRate), encoding: "pcm_s16le", format_turns: "true" });
  if (keyterms.length) q.set("keyterms_prompt", JSON.stringify(keyterms));
  return q;
}

// Words the recognizer should expect on this line (boosts accuracy on legal/benefits vocabulary): the line's own
// list, then every rule's key terms from the rules engine, within AssemblyAI's cap of 100.
const LINE_TERMS = ["Social Security", "reconsideration", "unlawful detainer", "summons", "three day notice",
  "eviction", "Medi-Cal", "CalFresh", "Notice of Action", "SSI", "disability", "landlord"];
export const KEYTERMS = [...new Set([...LINE_TERMS, ...RULE_TERMS])].slice(0, 100);
