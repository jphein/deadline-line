// Vendored from jphein/deadline-decoder-mcp (develop @ e0d4a46c5030f1cc0a2078ccaaac3abed7871e38), licensed AGPL-3.0-or-later: see vendor/deadline-decoder-mcp/LICENSE.
// Upstream edits belong upstream: change them there and re-vendor with scripts/vendor-decoder.sh, rather than patch here.
// dates.js — deadline arithmetic. Pure functions, no DOM, tested in tests/dates.test.mjs.
// All dates are local calendar dates handled as UTC-midnight Date objects to avoid DST drift.

export function d(iso) {                       // "2026-09-13" -> Date (UTC midnight)
  const [y, m, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
export function iso(date) { return date.toISOString().slice(0, 10); }
export function addDays(date, n) { const x = new Date(date); x.setUTCDate(x.getUTCDate() + n); return x; }
export function dow(date) { return date.getUTCDay(); }            // 0 Sun … 6 Sat
export function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

function nthWeekday(y, month, weekday, n) {     // n-th weekday (1-based) of month (0-based)
  const first = new Date(Date.UTC(y, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(y, month, 1 + offset + (n - 1) * 7));
}
function lastWeekday(y, month, weekday) {
  const last = new Date(Date.UTC(y, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(y, month + 1, -offset));
}
function observed(date) {                        // Sat -> Fri, Sun -> Mon
  const w = dow(date);
  return w === 6 ? addDays(date, -1) : w === 0 ? addDays(date, 1) : date;
}

// California judicial holidays (Code Civ. Proc. §§ 135, 12a; Gov. Code § 6700).
// 2026 is checked against courts.ca.gov/about/court-holidays (read 2026-09-26).
// Other years are computed from the same rules; the page says so.
export const CA_VERIFIED_YEARS = [2026];
export function caCourtHolidays(y) {
  const list = [
    [observed(d(`${y}-01-01`)), "New Year's Day"],
    [nthWeekday(y, 0, 1, 3), "Martin Luther King Jr. Day"],
    [observed(d(`${y}-02-12`)), "Lincoln's Birthday"],
    [nthWeekday(y, 1, 1, 3), "Presidents' Day"],
    [observed(d(`${y}-03-31`)), "César Chávez Day"],
    [lastWeekday(y, 4, 1), "Memorial Day"],
    [observed(d(`${y}-06-19`)), "Juneteenth"],
    [observed(d(`${y}-07-04`)), "Independence Day"],
    [nthWeekday(y, 8, 1, 1), "Labor Day"],
    [nthWeekday(y, 8, 5, 4), "Native American Day"],
    [observed(d(`${y}-11-11`)), "Veterans Day"],
    [nthWeekday(y, 10, 4, 4), "Thanksgiving"],
    [addDays(nthWeekday(y, 10, 4, 4), 1), "Day after Thanksgiving"],
    [observed(d(`${y}-12-25`)), "Christmas Day"],
  ];
  return new Map(list.map(([dt, name]) => [iso(dt), name]));
}

// Federal holidays (5 U.S.C. § 6103), observed dates for federal employees.
export function federalHolidays(y) {
  const list = [
    [observed(d(`${y}-01-01`)), "New Year's Day"],
    [nthWeekday(y, 0, 1, 3), "Martin Luther King Jr. Day"],
    [nthWeekday(y, 1, 1, 3), "Washington's Birthday"],
    [lastWeekday(y, 4, 1), "Memorial Day"],
    [observed(d(`${y}-06-19`)), "Juneteenth"],
    [observed(d(`${y}-07-04`)), "Independence Day"],
    [nthWeekday(y, 8, 1, 1), "Labor Day"],
    [nthWeekday(y, 9, 1, 2), "Columbus Day"],
    [observed(d(`${y}-11-11`)), "Veterans Day"],
    [nthWeekday(y, 10, 4, 4), "Thanksgiving"],
    [observed(d(`${y}-12-25`)), "Christmas Day"],
  ];
  return new Map(list.map(([dt, name]) => [iso(dt), name]));
}

// Legal holidays in the District of Columbia (D.C. Code § 1-612.02): the federal ones, plus D.C. Emancipation
// Day (April 16, observed on the nearest weekday) and Inauguration Day (January 20 every fourth year; the 21st
// when the 20th is a Sunday). Tax deadlines roll past these (26 U.S.C. §§ 6213(a), 7503).
export function dcHolidays(y) {
  const m = federalHolidays(y);
  m.set(iso(observed(d(`${y}-04-16`))), "D.C. Emancipation Day");
  if ((y - 2021) % 4 === 0) { const jan20 = d(`${y}-01-20`); m.set(iso(dow(jan20) === 0 ? addDays(jan20, 1) : jan20), "Inauguration Day"); }
  return m;
}

function holidayName(date, fn) {
  const y = date.getUTCFullYear();
  return fn(y).get(iso(date)) || fn(y + 1).get(iso(date)) || null;
}
export function isCourtDay(date) { const w = dow(date); return w !== 0 && w !== 6 && !holidayName(date, caCourtHolidays); }
export function isFederalWorkday(date) { const w = dow(date); return w !== 0 && w !== 6 && !holidayName(date, federalHolidays); }
export function isDcBusinessDay(date) { const w = dow(date); return w !== 0 && w !== 6 && !holidayName(date, dcHolidays); }
export function whyNotWorkday(date) {
  const w = dow(date);
  return w === 0 ? "Sunday" : w === 6 ? "Saturday"
    : holidayName(date, federalHolidays) || holidayName(date, caCourtHolidays) || holidayName(date, dcHolidays);
}

// Count n court days, starting the day AFTER `from` (Code Civ. Proc. § 12). Returns the
// last day plus the skipped days, so the page can show its working.
export function addCourtDays(from, n) {
  let x = new Date(from), counted = 0; const skipped = [];
  while (counted < n) {
    x = addDays(x, 1);
    if (isCourtDay(x)) counted++;
    else skipped.push({ date: iso(x), why: dow(x) === 0 ? "Sunday" : dow(x) === 6 ? "Saturday" : holidayName(x, caCourtHolidays) });
  }
  return { date: x, skipped };
}

// Calendar days, then roll forward to the next day that passes `ok` (weekend/holiday rule).
export function addDaysRolling(from, n, ok) {
  let x = addDays(from, n); const rolled = [];
  while (!ok(x)) {
    rolled.push({ date: iso(x), why: whyNotWorkday(x) });
    x = addDays(x, 1);
  }
  return { date: x, rolled };
}

export function fmt(date) {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
export function fmtDay(date) {                   // "Monday, November 2": a nearby day, said aloud
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
export function fmtShort(date) {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

// Find a date in pasted letter text. Returns ISO or null. Prefers dates near "date of this notice",
// "Date:", "served", "effective".
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
export function findDates(text) {
  const out = [];
  const re1 = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "gi");
  const re2 = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})\b/g;
  let m;
  while ((m = re1.exec(text))) {
    const mi = MONTHS.split("|").indexOf(m[1].toLowerCase().replace(/\.$/, ""));
    const month = [0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,5,6,7,8,8,9,10,11][mi];
    out.push({ iso: iso(new Date(Date.UTC(+m[3], month, +m[2]))), at: m.index });
  }
  while ((m = re2.exec(text))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    out.push({ iso: iso(new Date(Date.UTC(y, +m[1] - 1, +m[2]))), at: m.index });
  }
  return out.sort((a, b) => a.at - b.at);
}
