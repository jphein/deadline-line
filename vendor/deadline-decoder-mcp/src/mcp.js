// Vendored from jphein/deadline-decoder-mcp (develop @ 613f9deca033fa1cdd2d8db750c8130ba7f05981), licensed AGPL-3.0-or-later: see vendor/deadline-decoder-mcp/LICENSE.
// Upstream edits belong upstream: change them there and re-vendor with scripts/vendor-decoder.sh, rather than patch here.
// mcp.js — registers Deadline Decoder's tools on an MCP server. One server per request
// (stateless Streamable HTTP), so this factory must be cheap and side-effect free.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listLetterTypes, computeDeadline, detectLetter, makeReminder, todayIso, DecoderError } from "./decoder.js";
import { RULES } from "./rules/rules.js";

export const SERVER_INFO = { name: "deadline-decoder", version: "0.1.0" };

const LETTER_IDS = RULES.map(r => r.id);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const INSTRUCTIONS = `Deadline Decoder answers "when is my deadline?" for letters about Social Security, California housing
and courts, and benefits; list_letter_types has the full list, with the date to ask for.
Never compute a deadline yourself: always call compute_deadline, and read its "speech" field aloud (it is written
for the ear). If the user describes or reads out a letter, call detect_letter first. If it returns candidates, ask
its "speech" question, then call detect_letter again with the answer and among set to those candidates. When the user answers a question
about the date, pass the letter you already know as letter_type. Always
confirm the date you pass as notice_date; letters whose needs_date is false print their own date and take none.
A "HEDGE" answer is what the deadline usually is: say so, and point to the date on the notice.
Answers are general information, not legal advice; point people to the free help the tool returns.`;

function result(obj) {
  return { content: [{ type: "text", text: obj.speech ?? JSON.stringify(obj) }], structuredContent: obj };
}
function failure(err) {
  if (err instanceof DecoderError) return { isError: true, content: [{ type: "text", text: err.message }] };
  throw err;
}

export function createMcpServer({ now } = {}) {
  const today = () => todayIso("America/Los_Angeles", now ? now() : new Date());
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool("list_letter_types", {
    title: "List letter types",
    description: "The kinds of letters Deadline Decoder understands, with the id to pass to other tools and which date to ask the user for.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const types = listLetterTypes();
    return { content: [{ type: "text", text: "I can help with: " + types.map(t => t.title).join("; ") + "." }], structuredContent: { letter_types: types } };
  });

  server.registerTool("detect_letter", {
    title: "Recognize a letter",
    description: "Given the words of a letter (pasted, OCR'd or read aloud), guess which kind it is and find any dates in it. Use before compute_deadline when the user hasn't said which letter they have.",
    inputSchema: {
      text: z.string().min(1).describe("The letter's text, or the user's description of it in their own words"),
      today: isoDate.optional().describe("Override today's date, used to resolve dates spoken without a year"),
      among: z.array(z.enum(LETTER_IDS)).max(10).optional().describe("The candidates a previous detect_letter returned, when this text answers its question"),
      letter_type: z.enum(LETTER_IDS).optional().describe("The kind of letter already identified, when this text answers the question about its date"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ text, today: t, among, letter_type }) => {
    try { return result(detectLetter(text, t ?? today(), among ?? [], { letterType: letter_type })); } catch (e) { return failure(e); }
  });

  server.registerTool("compute_deadline", {
    title: "Compute the real deadline",
    description: "Exact, cited deadline math for one letter: the deadline date, days left, what to do, how it was counted (mailing presumptions, skipped weekends and court holidays), next steps, free help and legal sources. The 'speech' field is ready to read aloud.",
    inputSchema: {
      letter_type: z.enum(LETTER_IDS).describe("An id from list_letter_types"),
      notice_date: isoDate.optional().describe("The date list_letter_types says to ask for: usually the date printed on the notice, or the date the person was served. Omit it only for letters whose needs_date is false."),
      today: isoDate.optional().describe("Override today's date (defaults to today in California)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ letter_type, notice_date, today: t }) => {
    try { return result(computeDeadline(letter_type, notice_date, t ?? today())); } catch (e) { return failure(e); }
  });

  server.registerTool("make_reminder", {
    title: "Make a calendar reminder",
    description: "An iCalendar (.ics) all-day event on the deadline with an alert one week before (or the day before if it's close). Return the file to the user or add it to their calendar.",
    inputSchema: {
      letter_type: z.enum(LETTER_IDS),
      notice_date: isoDate,
      today: isoDate.optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ letter_type, notice_date, today: t }) => {
    try { return result(makeReminder(letter_type, notice_date, t ?? today())); } catch (e) { return failure(e); }
  });

  return server;
}
