// /api/decode on Vercel. GET: the greeting. POST {transcript, state?, today?}: the line's reply. See src/handlers.js.
import { apiRoutes } from "../src/handlers.js";

export const { GET, POST } = apiRoutes(process.env, "vercel")["/api/decode"];
