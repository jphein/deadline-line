// GET /api/healthz: {ok, stt, mode: "vercel"}. The page reads mode to call AssemblyAI directly. See src/vercel.js.
import { healthHandler } from "../src/vercel.js";

export const GET = healthHandler();
