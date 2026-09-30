// worker.js — Cloudflare Workers entry (see wrangler.toml). /api/token, /api/decode and /api/healthz go to the
// platform-neutral handlers in src/handlers.js; any other path is the static page (Workers Static Assets serves
// the files in public/ before this Worker runs). Secret: ASSEMBLYAI_API_KEY, set with `wrangler secret put`.
import { apiRoutes, router } from "./src/handlers.js";

export default { fetch: router((env) => apiRoutes(env, "cloudflare-workers")) };
