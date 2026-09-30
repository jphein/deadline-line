// Vendored from jphein/deadline-decoder-mcp (develop @ 6a87918), licensed AGPL-3.0-or-later: see vendor/deadline-decoder-mcp/LICENSE.
// Upstream edits belong upstream: change them there and re-vendor with scripts/vendor-decoder.sh, rather than patch here.
// SPDX-License-Identifier: AGPL-3.0-or-later
// decoder.js — the domain layer the MCP tools call. Pure functions over the cited rules in src/rules/
// (which began as Deadline Decoder's and have grown since). No I/O here, so every answer is testable.
import { d, iso, addDays, daysBetween, fmt, findDates } from "./rules/dates.js";
import { RULES, SPOKEN_ORDER, AMBIGUOUS, detect } from "./rules/rules.js";

export { KEYTERMS } from "./rules/rules.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DecoderError extends Error {}

// Today's date in the user's timezone (default Pacific, where every rule here applies).
export function todayIso(tz = "America/Los_Angeles", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function parseIso(s, field) {
  if (typeof s !== "string" || !ISO_RE.test(s)) throw new DecoderError(`${field} must be a date like 2026-09-13`);
  const dt = d(s);
  if (Number.isNaN(dt.getTime()) || iso(dt) !== s) throw new DecoderError(`${field} is not a real calendar date: ${s}`);
  return dt;
}

function findRule(id) {
  const r = RULES.find(x => x.id === id);
  if (!r) throw new DecoderError(`Unknown letter_type "${id}". Call list_letter_types for the valid ids.`);
  return r;
}

export function listLetterTypes() {
  return RULES.map(r => ({ id: r.id, title: r.title, description: r.plain, date_to_ask_for: r.dateLabel ?? null,
    family: r.family, confidence: r.confidence, needs_date: r.anchor !== null }));
}

// The rules write their working for the eye ("2026-09-25 skipped — Native American Day.").
// Rewrite it for the ear: spoken dates, no dashes, no ISO strings.
const spokenShort = (isoStr) => d(isoStr).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
export function forTheEar(line) {
  return line
    .replace(/^(\d{4}-\d{2}-\d{2}) skipped — (.+?)\.?$/, (_, x, why) => `${spokenShort(x)} is skipped: ${/day$/i.test(why) && !/^(Saturday|Sunday)$/.test(why) ? `it's ${why}` : `it's a ${why}`}.`)
    .replace(/^(\d{4}-\d{2}-\d{2}) is a (.+?), so/, (_, x, why) => `${spokenShort(x)} is a ${why}, so`)
    .replace(/ — /g, ", ");
}

function daysPhrase(n) {
  if (n > 1) return `${n} days from today`;
  if (n === 1) return "tomorrow";
  if (n === 0) return "today";
  if (n === -1) return "yesterday — it has passed";
  return `${-n} days ago — it has passed`;
}

// A SOLID rule states the deadline. A HEDGE rule says what it usually is and sends people to the date on their
// notice; one with nothing to count (a jury summons prints its own date) just says so.
export function computeDeadline(letterType, noticeDate, today = todayIso()) {
  const rule = findRule(letterType);
  const now = parseIso(today, "today");
  const notice = rule.anchor === null && noticeDate == null ? null : parseIso(noticeDate, "notice_date");
  const r = rule.compute(notice);
  const help = `For free help: ${r.help[0].name}, ${r.help[0].how}.`;
  const common = {
    letter_type: rule.id, letter_title: rule.title, notice_date: noticeDate ?? null, confidence: rule.confidence,
    what_to_do: r.headline, how_we_counted: r.math, next_steps: r.steps, free_help: r.help, sources: r.sources,
  };
  if (!r.deadline) {
    const lead = r.hedge;
    return { ...common, deadline: null, deadline_spoken: null, days_left: null, passed: false, lead_spoken: lead, also: [], also_spoken: null,
      speech: [lead, `${r.headline}.`, `First step: ${r.steps[0]}`, help, "This is general information, not legal advice."].join(" ") };
  }
  const daysLeft = daysBetween(now, r.deadline);
  const late = daysLeft < 0, hedged = rule.confidence === "HEDGE";
  const also = (r.also ?? []).map(a => a.deadline
    ? { label: a.label, confidence: a.confidence, date: iso(a.deadline), date_spoken: fmt(a.deadline), passed: daysBetween(now, a.deadline) < 0 }
    : { label: a.label, confidence: a.confidence, date: null, date_spoken: null, passed: false });
  const alsoSpoken = also.map(a => (a.date ? a.label.replace("{date}", a.date_spoken) : a.label) + (a.passed ? " That date has passed." : "")).join(" ");
  // A notice that sets the earliest date something can happen (a tenancy ending, a rent increase) says so in its own words.
  const lead = rule.lead
    ? `${rule.lead.replace("{date}", fmt(r.deadline))}, ${daysPhrase(daysLeft).replace(" — it has passed", "")}.${late ? " That date has passed." : ""}`
    : hedged
    ? `For this kind of notice the deadline is usually ${fmt(r.deadline)}, ${daysPhrase(daysLeft)}. Check the notice itself: if it gives a different date, go by the notice.`
    : late
      ? `The deadline was ${fmt(r.deadline)}, ${daysPhrase(daysLeft)}. It may not be too late: ask for more time in writing and explain why, and call free legal aid today.`
      : `Your deadline is ${fmt(r.deadline)}, ${daysPhrase(daysLeft)}.`;
  const speech = [
    lead,
    `${r.headline}.`,
    ...(alsoSpoken ? [alsoSpoken] : []),
    `Here's how I counted. ${r.math.map(forTheEar).join(" ")}`,
    `First step: ${r.steps[0]}`,
    help,
    "This is general information, not legal advice.",
  ].join(" ");
  return {
    ...common,
    deadline: iso(r.deadline),
    deadline_spoken: fmt(r.deadline),
    days_left: daysLeft,
    passed: late,
    lead_spoken: lead,
    also,
    also_spoken: alsoSpoken || null,
    speech,
  };
}

// Spoken dates rarely carry a year: "dated September 13th", "the 2nd of October", "yesterday".
// Resolve them to the most recent such date on or before today (letters arrive after their date).
const MONTH_NAMES = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
function monthIndex(word) { return MONTH_NAMES.findIndex(m => m.startsWith(word.toLowerCase().slice(0, 3))); }
function mostRecent(month, day, today) {
  for (const y of [today.getUTCFullYear(), today.getUTCFullYear() - 1]) {
    const dt = new Date(Date.UTC(y, month, day));
    if (dt.getUTCMonth() === month && dt <= today) return iso(dt);
  }
  return null;
}
export function findSpokenDates(text, today = todayIso()) {
  const now = d(today), out = [];
  const add = (at, isoStr) => { if (isoStr) out.push({ at, iso: isoStr }); };
  let m;
  const a = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!,?\\s*20\\d{2})`, "gi");
  while ((m = a.exec(text))) add(m.index, mostRecent(monthIndex(m[1]), +m[2], now));
  const b = new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+${MONTH_RE}\\b`, "gi");
  while ((m = b.exec(text))) add(m.index, mostRecent(monthIndex(m[2]), +m[1], now));
  const c = /\b(today|yesterday)\b/gi;
  while ((m = c.exec(text))) add(m.index, iso(addDays(now, m[1].toLowerCase() === "today" ? 0 : -1)));
  return out;
}

// How people *say* it, as opposed to what the letter prints: each rule's `spoken` pattern, tried in
// SPOKEN_ORDER (most specific first). Used when the printed-letter detector finds nothing, or to hear "denied again".
function detectSpoken(text) {
  for (const id of SPOKEN_ORDER) { const r = RULES.find(x => x.id === id); if (r?.spoken?.test(text)) return r; }
  return null;
}

// What each family of letters is about, for "which kind is it?" (in this order, when the family has rules).
const FAMILY_ASK = [["ssa", "Social Security"], ["housing", "your rent or your home"], ["court", "a court case or jury duty"],
  ["traffic", "a parking ticket"], ["unemployment", "unemployment benefits"], ["tax", "taxes or the IRS"], ["benefits", "Medi-Cal, CalFresh or CalWORKs"]];
const families = new Set(RULES.map(r => r.family));
const asked = FAMILY_ASK.filter(([f]) => families.has(f)).map(([, what]) => what);
export const UNKNOWN_LETTER = `I couldn't tell which kind of letter that is. Is it about ${asked.slice(0, -1).join(", ")}, or ${asked.at(-1)}?`;

/** Which kind of letter is this? `among`: the candidate ids from a "which one?" question, to match the answer to. */
export function detectLetter(text, today = todayIso(), among = []) {
  if (typeof text !== "string") throw new DecoderError("text must be a string");
  let rule = among.map(findRule).find(r => r.answers?.test(text)) ?? null;
  if (!rule) {
    // A printed initial denial names "reconsideration" as the next step, so the printed detector
    // can't hear "denied *again*"; the spoken detector can, and wins in that one case.
    const printed = detect(text), spoken = detectSpoken(text);
    rule = printed?.id === "ssa-initial" && spoken?.id === "ssa-recon" ? spoken : (printed ?? spoken);
  }
  const group = rule ? null : AMBIGUOUS.find(g => g.spoken.test(text));
  const dates = [...findDates(text), ...findSpokenDates(text, today)].sort((x, y) => x.at - y.at).map(x => x.iso);
  const ask = rule?.dateLabel ? (dates[0] ? `I see the date ${fmt(d(dates[0]))}. Is that the ${rule.dateLabel.toLowerCase()}?` : `What is the ${rule.dateLabel.toLowerCase()}?`) : "";
  return {
    letter_type: rule ? rule.id : null,
    letter_title: rule ? rule.title : null,
    recognized: Boolean(rule),
    confidence: rule ? rule.confidence : null,
    needs_date: rule ? rule.anchor !== null : null,
    date_question: rule?.dateQuestion ?? null,
    candidates: group ? group.candidates : [],
    dates_found: dates,
    suggested_notice_date: dates[0] ?? null,
    speech: rule ? `That sounds like: ${rule.title}.${ask ? ` ${ask}` : ""}` : group ? group.question : UNKNOWN_LETTER,
  };
}

function icsDate(dt) { return iso(dt).replaceAll("-", ""); }
function icsEscape(s) { return s.replace(/[\\;,]/g, m => `\\${m}`).replace(/\n/g, "\\n"); }

// An all-day event on the deadline, with an alarm one week before (or at 9am the day before
// if the deadline is under a week away). Returned as text; the client decides how to deliver it.
export function makeReminder(letterType, noticeDate, today = todayIso()) {
  const res = computeDeadline(letterType, noticeDate, today);
  if (!res.deadline) throw new DecoderError(`${res.letter_title} prints its own date, so there's no date for me to put in a reminder. Use the date on it.`);
  if (res.passed) throw new DecoderError(`That deadline (${res.deadline_spoken}) has already passed, so there is nothing to remind about. Ask for more time in writing and call free legal aid.`);
  const deadline = d(res.deadline);
  const trigger = res.days_left > 7 ? "-P7D" : "-PT15H";
  const uid = `${res.letter_type}-${res.notice_date}-${res.deadline}@deadline-decoder`;
  const desc = [res.what_to_do + ".", ...res.how_we_counted, "", ...res.next_steps, "", "Free help: " + res.free_help.map(h => `${h.name} (${h.how})`).join("; ")].join("\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Deadline Decoder//MCP//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsDate(d(today))}T000000Z`,
    `DTSTART;VALUE=DATE:${icsDate(deadline)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(deadline, 1))}`,
    `SUMMARY:${icsEscape("DEADLINE: " + res.what_to_do)}`,
    `DESCRIPTION:${icsEscape(desc)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:${trigger}`, `DESCRIPTION:${icsEscape("Deadline coming: " + res.what_to_do)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
  return {
    deadline: res.deadline,
    reminder: res.days_left > 7 ? "one week before" : "the day before",
    filename: `deadline-${res.deadline}.ics`,
    ics,
    speech: `I made a calendar reminder for ${res.deadline_spoken}, with an alert ${res.days_left > 7 ? "one week before" : "the day before"}.`,
  };
}
