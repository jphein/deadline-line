// GET /api/decode: the greeting. POST /api/decode {transcript, state?, today?}: the line's reply. See src/vercel.js.
import { decodeHandlers } from "../src/vercel.js";

export const { GET, POST } = decodeHandlers();
