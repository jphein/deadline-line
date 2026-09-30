// GET /api/token on Vercel: a temporary AssemblyAI streaming token for one browser call. See src/handlers.js.
import { apiRoutes } from "../src/handlers.js";

export const { GET } = apiRoutes(process.env, "vercel")["/api/token"];
