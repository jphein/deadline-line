// GET /api/token: a temporary AssemblyAI streaming token for one browser call. See src/vercel.js.
import { tokenHandler } from "../src/vercel.js";

export const GET = tokenHandler();
