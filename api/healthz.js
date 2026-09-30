// GET /api/healthz on Vercel: {ok, stt, mode: "direct", platform: "vercel"}. See src/handlers.js.
import { apiRoutes } from "../src/handlers.js";

export const { GET } = apiRoutes(process.env, "vercel")["/api/healthz"];
