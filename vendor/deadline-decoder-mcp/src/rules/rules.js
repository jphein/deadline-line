// Vendored from jphein/deadline-decoder-mcp (develop @ a960445b16f738ad759e0f8f003a76d1d0037b0b), licensed AGPL-3.0-or-later: see vendor/deadline-decoder-mcp/LICENSE.
// Upstream edits belong upstream: change them there and re-vendor with scripts/vendor-decoder.sh, rather than patch here.
// SPDX-License-Identifier: AGPL-3.0-or-later
// rules.js — one entry per kind of letter. Every rule cites its source, and every result shows its
// arithmetic. The first five rules count with hand-written compute() functions; newer ones are written as data
// with spec() and counted by count(): an anchor date, an optional mailing presumption, N calendar or court days,
// then a roll-forward rule for a last day on a weekend or holiday. A HEDGE rule says "usually" and sends people
// to the date printed on their notice. When a statute's roll-forward rule isn't certain, a rule doesn't roll:
// an answer that is early is safe, and one that is late isn't.
import { d, addDays, addCourtDays, addDaysRolling, isFederalWorkday, isCourtDay, isDcBusinessDay, whyNotWorkday, fmt, fmtDay, iso, CA_VERIFIED_YEARS } from "./dates.js";

const LSNC = { name: "Legal Services of Northern California", how: "free civil legal aid — lsnc.net or call your local office" };
const LAWHELP = { name: "LawHelpCA.org", how: "find free legal aid anywhere in California by county" };
const SELFHELP = { name: "California Courts Self-Help Guide", how: "selfhelp.courts.ca.gov — forms and step-by-step help" };
const TWO11 = { name: "211", how: "dial 2-1-1 from any phone, 24/7, English and Spanish" };
const JURY = { name: "Your court's jury office", how: "the phone number and website are printed on your summons",
  say: "For questions, call your court's jury office: the phone number and website are printed on your summons." };
const EDD = { name: "EDD", how: "1-800-300-5616 in English, 1-800-326-8937 in Spanish" };
const SSA = { name: "Social Security", how: "1-800-772-1213 (TTY 1-800-325-0778)" };
const STATE_HEARINGS = { name: "CDSS State Hearings", how: "(800) 743-8525 (voice and TDD)" };
const TAS = { name: "Taxpayer Advocate Service", how: "1-877-777-4778, free help when an IRS problem isn't getting fixed" };
const LITC = { name: "A Low Income Taxpayer Clinic", how: "free or low-cost help with IRS disputes if you qualify; the Taxpayer Advocate Service lists clinics by state",
  say: "For help, a Low Income Taxpayer Clinic gives free or low-cost help with IRS disputes if you qualify; the Taxpayer Advocate Service lists clinics by state." };
const PARKING_AGENCY = { name: "The agency that gave the ticket", how: "its phone number and website are on the ticket or notice",
  say: "For questions, contact the agency that gave the ticket: its phone number and website are on the ticket or notice." };
const PAYPLAN = "If you get public benefits or have a low income, ask the agency about a payment plan. People who qualify must be offered one before an unpaid ticket is sent to the DMV.";

function yearNote(date) {
  return CA_VERIFIED_YEARS.includes(date.getUTCFullYear()) ? "" :
    " Court holidays for this year are computed from the statute, not checked against the court calendar — confirm with the court.";
}

// ---- rules as data ----------------------------------------------------------------------------------------------
// How a last day that isn't a working day moves forward. "none": it doesn't (the statute counts calendar days and
// says nothing more, or its rule isn't certain). court: Code Civ. Proc. §§ 12a, 135. federal: 20 CFR 404.3(b).
// dc: 26 U.S.C. §§ 6213(a), 7503 (Saturday, Sunday, or a legal holiday in the District of Columbia).
export const ROLL = {
  none: { ok: () => true, next: "" },
  court: { ok: isCourtDay, next: "court day" },
  federal: { ok: isFederalWorkday, next: "workday" },
  dc: { ok: isDcBusinessDay, next: "business day" },
};
// The date each kind of rule counts from, as the first counting step says it.
export const ANCHORS = { notice: "Notice dated", served: "Served", issued: "Issued", mailed: "Mailed", received: "Received", due: "The bill was due" };
const WORDS = ["zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** Count a rule's days from its anchor date. Returns the last day, the uncorrected last day, and what moved it. */
export function count(anchor, { days, unit = "calendar", mail = 0, roll = "none" }) {
  if (!ROLL[roll]) throw new Error(`unknown roll rule: ${roll}`);
  const start = addDays(anchor, mail);
  if (unit === "court") { const { date, skipped } = addCourtDays(start, days); return { start, raw: date, date, skipped, rolled: [] }; }
  if (unit !== "calendar") throw new Error(`unknown unit: ${unit}`);
  const { date, rolled } = addDaysRolling(start, days, ROLL[roll].ok);
  return { start, raw: addDays(start, days), date, skipped: [], rolled };
}

function rollLine(rolled, date, next) {
  const what = (w) => (/^(Saturday|Sunday)$/.test(w) ? `a ${w}` : w);
  const also = rolled.slice(1).filter(r => !/^(Saturday|Sunday)$/.test(r.why)).map(r => `${fmtDay(d(r.date))} is ${r.why}`);
  return `That's ${what(rolled[0].why)}${also.length ? `, and ${also.join(", and ")}` : ""}, so the deadline moves to the next ${next}: ${fmt(date)}.`;
}

/** The counting steps, written to be read or heard (no ISO dates). */
export function countSteps(s, anchor, c) {
  const { days, unit = "calendar", mail = 0, roll = "none" } = s.count;
  const lines = [`${ANCHORS[s.anchor]} ${fmt(anchor)}.${s.anchor === "served" ? " The day you are served does not count." : ""}`];
  if (mail) lines.push(`${s.mailWho ?? "The law"} assumes you got it ${mail} days later: ${fmt(c.start)}.`);
  if (unit === "court") {
    lines.push("Saturdays, Sundays and court holidays do not count.");
    lines.push(...c.skipped.filter(x => !/Saturday|Sunday/.test(x.why)).map(x => `${x.date} skipped — ${x.why}.`));
    lines.push(`${WORDS[days] ?? days} court days end ${fmt(c.date)}.` + yearNote(c.date));
  } else {
    const from = mail ? "then" : s.anchor === "served" ? "the day you were served" : "that date";
    lines.push(`${s.confidence === "HEDGE" ? "Usually the deadline is " : ""}${days} days from ${from}: ${fmt(c.raw)}.`);
    if (c.rolled.length) lines.push(rollLine(c.rolled, c.date, ROLL[roll].next) + (roll === "court" ? yearNote(c.date) : ""));
    // A rule that doesn't roll says so when its day isn't a working day, instead of passing it off as final.
    if (roll === "none" && !s.lead && !isCourtDay(c.raw)) lines.push(`That's ${/^(Saturday|Sunday)$/.test(whyNotWorkday(c.raw)) ? `a ${whyNotWorkday(c.raw)}` : whyNotWorkday(c.raw)}. Don't count on extra time: act before then.`);
  }
  if (s.note) lines.push(s.note);
  return lines;
}

/** A second, earlier date some letters carry, such as the last day to keep Social Security from recovering while it
 *  decides. `label` says it, with {date} where the date goes; counted in calendar days from the anchor and never
 *  rolled (early is safe). An item without `days` is a sentence with no date of its own. */
function alsoDates(list = [], anchor) {
  return list.map(a => ({ label: a.label, confidence: a.confidence ?? "SOLID", deadline: a.days === undefined ? null : addDays(anchor, (a.mail ?? 0) + a.days) }));
}

/** A rule written as data. Needs: id, family, title, plain, anchor (a key of ANCHORS, or null when the notice
 *  prints its own date and there is nothing to count), count, headline, steps, help, sources, detect, spoken,
 *  answers, keyterms. Optional: confidence ("SOLID", or "HEDGE" plus a `hedge` sentence), dateLabel,
 *  dateQuestion, mailWho, not (printed cues that rule it out), also (see alsoDates), note (a last counting step),
 *  lead (the answer's first sentence, with {date}, for a notice that sets the earliest date something can happen),
 *  unhedge (true: the rule reads the text through unhedged(), for "is this a suit?"). */
export function spec(s) {
  return {
    confidence: "SOLID", ...s,
    compute(anchor) {
      const base = { headline: s.headline, steps: s.steps, help: s.help, sources: s.sources, hedge: s.hedge };
      if (!s.count) return { ...base, deadline: null, math: [], also: [] };
      const c = count(anchor, s.count);
      return { ...base, deadline: c.date, math: countSteps(s, anchor, c), also: alsoDates(s.also, anchor) };
    },
  };
}

export const RULES = [
  {
    id: "ssa-recon",
    family: "ssa", confidence: "SOLID", anchor: "notice", not: /^(?!.*\b(reconsider\w*|denied|deny|denial|again|second time|twice|not disabled|unfavorable|turned (me )?down|said no|rejected|appeal\w*|judge|ALJ)\b)(?=.*\bhearings?\b)|^(?!.*\b(reconsider\w*|denied|deny|denial|again|second time|twice|not disabled|unfavorable|turned (me )?down|said no|rejected|appeal\w*)\b)(?=.*\b(small claims|custody|divorce|restraining order|immigration|deportation|criminal|misdemeanor|felony|probation|parole|traffic|school|IEP|expulsion|IRS|internal revenue|lev(y|ies|ying)|garnish\w*|debt collector|collection agency|PG&E|utility|shut ?off)\b)|^(?!.*notice of reconsideration).*(overpa(id|yment)|\b(unlawful detainer|eviction (summons|papers|notice|lawsuit|case)|(3|three)[- ]day notice|notice to (vacate|quit|pay rent))\b)|notice of decision|\b(administrative law judge|ALJ) (found|decided|dismissed)|\bjudge (ruled|decided|denied)\b|^(?!.*notice of reconsideration).*hearing decision/is,
    spoken: /\b(social security|ssi|ssdi|disability)\b.*\b(again|second time|twice|reconsidered)\b|\b(again|second time|twice|reconsidered)\b.*\b(social security|ssi|ssdi|disability)\b/i,
    answers: /\b(again|second|twice|reconsider\w*|hearing)\b/i,
    keyterms: ["Social Security", "reconsideration", "administrative law judge", "SSI", "disability"],
    title: "Social Security: my claim was denied (again)",
    plain: "A Social Security notice of reconsideration — the second \"no\".",
    detect: [/reconsideration/i, /social security/i, /(hearing|administrative law judge)/i],
    dateLabel: "Date printed on the notice",
    compute(notice) {
      const received = addDays(notice, 5);
      const { date, rolled } = addDaysRolling(received, 60, isFederalWorkday);
      return {
        deadline: date,
        headline: "Ask for a hearing before a judge",
        math: [
          `Notice dated ${fmt(notice)}.`,
          `Social Security assumes you got it 5 days later: ${fmt(received)}.`,
          `You have 60 days from then: ${fmt(addDays(received, 60))}.`,
          ...rolled.map(r => `${r.date} is a ${r.why}, so the deadline moves to the next workday.`),
        ],
        steps: [
          "File form HA-501, Request for Hearing by Administrative Law Judge. It is free.",
          "You can file online at ssa.gov (Appeal a Decision), by mail, by fax, or in person at any Social Security office.",
          "Keep proof: a fax confirmation, a certified-mail receipt, or the online confirmation number.",
          "You can withdraw a hearing request later. Missing the deadline usually cannot be undone.",
          "If you missed it, you can still ask for more time in writing and explain why (\"good cause\").",
        ],
        help: [LSNC, LAWHELP, TWO11, { name: "Social Security", how: "1-800-772-1213 (TTY 1-800-325-0778)" }],
        sources: ["20 CFR 404.933 and 416.1433 (60 days after you receive the notice)",
                  "20 CFR 404.901 and 416.1401 (notice presumed received 5 days after its date)",
                  "20 CFR 404.3(b) and 416.120(d) (a deadline on a weekend or federal holiday moves to the next workday)"],
      };
    },
  },
  {
    id: "ssa-initial",
    family: "ssa", confidence: "SOLID", anchor: "notice", not: /\b(administrative law judge|ALJ) (found|decided|dismissed)|\bjudge (ruled|decided|denied)\b|^(?!.*notice of reconsideration).*hearing decision/is,
    spoken: /\b(social security|ssi|ssdi)\b.*\b(denied|turned (me )?down|rejected|said no)\b|\b(denied|turned down|rejected)\b.*\b(social security|ssi|ssdi|disability)\b/i,
    answers: /\b(first|denied|application|turned down)\b/i,
    keyterms: ["Social Security", "SSI", "SSDI", "disability"],
    title: "Social Security: my application was denied",
    plain: "The first \"no\" on a disability, SSI or other Social Security claim.",
    detect: [/social security/i, /(not disabled|denied|we have determined)/i, /reconsideration/i],
    dateLabel: "Date printed on the notice",
    compute(notice) {
      const received = addDays(notice, 5);
      const { date, rolled } = addDaysRolling(received, 60, isFederalWorkday);
      return {
        deadline: date,
        headline: "Ask Social Security to reconsider",
        math: [`Notice dated ${fmt(notice)}.`, `Presumed received 5 days later: ${fmt(received)}.`,
               `60 days from then: ${fmt(addDays(received, 60))}.`,
               ...rolled.map(r => `${r.date} is a ${r.why}, so the deadline moves to the next workday.`)],
        steps: ["File form SSA-561, Request for Reconsideration (with SSA-3441 for disability claims). It is free.",
                "File online at ssa.gov (Appeal a Decision), by mail, or at any Social Security office.",
                "Keep proof of when you filed."],
        help: [LSNC, LAWHELP, TWO11, { name: "Social Security", how: "1-800-772-1213" }],
        sources: ["20 CFR 404.909 and 416.1409 (60 days after receipt)", "20 CFR 404.901 and 416.1401 (5-day presumption)",
                  "20 CFR 404.3(b) and 416.120(d) (weekend and holiday rule)"],
      };
    },
  },
  {
    id: "ca-3day",
    family: "housing", confidence: "SOLID", anchor: "served",
    spoken: /\b(3|three)[- ]day notice\b|\bnotice to pay (rent )?or quit\b/i,
    answers: /\b(3|three)[- ]day|pay (rent )?or quit\b/i,
    keyterms: ["three day notice", "pay rent or quit", "landlord"],
    title: "California: a 3-day notice to pay rent or move out",
    plain: "A notice from a landlord giving you three days to pay rent or leave.",
    detect: [/(three|3)[- ]day/i, /(pay rent|quit|notice to pay)/i],
    dateLabel: "Date the notice was handed to you (or posted and mailed)",
    compute(served) {
      const { date, skipped } = addCourtDays(served, 3);
      return {
        deadline: date,
        headline: "Pay, or get help, before the notice runs out",
        math: [`Served ${fmt(served)}. The day you are served does not count.`,
               "Saturdays, Sundays and court holidays do not count either.",
               ...skipped.map(s => `${s.date} skipped — ${s.why}.`),
               `Three court days end ${fmt(date)}.` + yearNote(date)],
        steps: ["A 3-day notice is not an eviction order. Only a court can evict you, and you will get court papers first.",
                "If you can pay the full amount demanded, pay it within the three court days and keep a receipt.",
                "Check the notice: it must state the amount, who to pay, and how. Mistakes can make it invalid.",
                "Call free legal aid now. Rental assistance or a payment plan may be possible.",
                "If you later get court papers (a Summons and Complaint), you have 10 court days to respond — use this tool again."],
        help: [LSNC, LAWHELP, SELFHELP, TWO11],
        sources: ["Code of Civil Procedure § 1161(2), as amended by AB 2343 (2018), effective Sept. 1, 2019 (excludes weekends and judicial holidays)",
                  "Code of Civil Procedure § 12 (the first day is excluded)", "Code of Civil Procedure § 135 and Gov. Code § 6700 (judicial holidays)"],
      };
    },
  },
  {
    id: "ca-ud",
    family: "housing", confidence: "SOLID", anchor: "served",
    spoken: /\beviction papers\b|unlawful detainer|\b(filed|filing|file) (an |the )?eviction\b|\bsu(ed|ing) (me )?to evict|\b(summons|court papers)\b.*\b(evict\w*|landlord|rent|tenant)\b|\b(evict\w*|landlord|rent)\b.*\b(summons|court papers)\b/i,
    // "UD" only in capitals (so "ud" inside other words, or Spanish "Ud.", isn't it); a sentence-final "UD." is.
    spokenCase: /\bUD\b/,
    answers: /\b(evict\w*|landlord|rent|tenant|apartment|housing|move out)\b/i,
    keyterms: ["unlawful detainer", "eviction", "summons"],
    title: "California: court papers for an eviction (Summons, unlawful detainer)",
    plain: "A Summons and Complaint — the landlord has filed an eviction case.",
    detect: [/unlawful detainer/i, /summons/i],
    dateLabel: "Date you were personally handed the papers",
    compute(served) {
      const { date, skipped } = addCourtDays(served, 10);
      return {
        deadline: date,
        headline: "File a response with the court",
        math: [`Served in person ${fmt(served)}. The day of service does not count.`,
               "Weekends and court holidays do not count.",
               ...skipped.filter(s => !/Saturday|Sunday/.test(s.why)).map(s => `${s.date} skipped — ${s.why}.`),
               `Ten court days end ${fmt(date)}.` + yearNote(date)],
        steps: ["File an Answer (form UD-105) or another response with the court by the deadline. If you do nothing, the landlord can win by default.",
                "Court fees can be waived if you qualify (form FW-001).",
                "If the papers were left with someone else or posted, you usually get extra days — ask legal aid; this tool assumes personal service.",
                "Call free legal aid today. Many tenants have defenses they do not know about."],
        help: [LSNC, SELFHELP, LAWHELP, TWO11],
        sources: ["Code of Civil Procedure § 1167, as amended by AB 2347 (2024), effective Jan. 1, 2025 (10 court days)",
                  "Code of Civil Procedure §§ 12, 135 (counting and holidays)"],
      };
    },
  },
  {
    id: "ca-noa",
    family: "benefits", confidence: "SOLID", anchor: "notice",
    spoken: /notice of action|\b(medi-?cal|calfresh|cal fresh|food stamps|ebt|cash aid|calworks)\b/i,
    answers: /\b(medi-?cal|calfresh|food stamps|calworks|cash aid|county|benefits)\b/i,
    keyterms: ["Medi-Cal", "CalFresh", "CalWORKs", "Notice of Action"],
    title: "Medi-Cal, CalFresh or CalWORKs: a Notice of Action",
    plain: "A county notice that your Medi-Cal, CalFresh (food stamps) or CalWORKs (cash aid) is being denied, cut, or stopped.",
    detect: [/notice of action/i, /(medi-cal|calfresh|cash aid|calworks)/i],
    dateLabel: "Date printed on the notice",
    compute(notice) {
      const deadline = addDays(notice, 90);
      return {
        deadline,
        headline: "Ask for a state hearing",
        math: [`Notice dated ${fmt(notice)}.`, `You have 90 days from the date of the notice: ${fmt(deadline)}.`,
               "With good cause, a late request can be accepted up to 180 days after the notice."],
        steps: ["Ask for a state hearing: call (800) 743-8525, go online, or fill in the back of the notice and mail it.",
                "To keep your benefits while you wait, ask BEFORE the date the change takes effect (it is on the notice). This is called \"aid paid pending\".",
                "Write down the date and time you asked and who you talked to.",
                "You can bring someone to help you, including free legal aid.",
                "If the notice is from your Medi-Cal health plan rather than the county, you usually appeal to the plan first, within 60 days of the date on it.",
                "For a Medi-Cal renewal decision, you may have 120 days from the date the notice was mailed. Check your notice."],
        help: [LSNC, { name: "CDSS State Hearings", how: "(800) 743-8525 (voice and TDD)" }, LAWHELP, TWO11],
        sources: ["Welfare and Institutions Code § 10951 (90 days; good cause up to 180)", "LSNC Guide to CalFresh Benefits — Requesting a fair hearing",
                  "42 CFR 431.211 and 431.230(a) (Medi-Cal: notice at least 10 days before the action; services continue if a hearing is asked for before it)",
                  "7 CFR 273.13(a)(1) and 273.15(k)(1) (CalFresh: at least 10 days' notice, with exceptions; benefits continue on a timely hearing request, but not past the end of the certification period, and are owed back if the action is upheld)",
                  "42 CFR 431.231(a) (Medi-Cal: services may be reinstated on a request within 10 days after the date of action)",
                  "CDSS, State Hearing requests (Medi-Cal renewal decisions: a temporary 120 days from the date the notice was mailed, since April 1, 2023)"],
        // No date of its own: the cutoff is the effective date printed on the notice, usually at least 10 days after
        // it but sometimes less, and the request has to come before it, so no computed day is safe to promise.
        also: [{ label: "You may be able to keep your benefits while you wait for the hearing, if you ask before the change takes effect. That date is printed on the notice, usually at least 10 days after it, so ask right away. If you lose, you may have to pay back CalFresh benefits you got while waiting.",
                 confidence: "HEDGE", deadline: null }],
      };
    },
  },
  // ---- court ------------------------------------------------------------------------------------------------
  spec({
    id: "ca-civil-summons",
    family: "court",
    title: "California: court papers for a lawsuit (a Summons that isn't about an eviction)",
    plain: "A Summons and Complaint in a civil case, such as a debt collector or a credit card company suing you.",
    anchor: "served",
    dateLabel: "Date you were personally handed the papers",
    dateQuestion: "What day were the papers handed to you? You can say something like September 13th.",
    count: { days: 30, unit: "calendar", roll: "court" },
    must: /\bsummons\b|citaci[oó]n judicial/i,
    unhedge: true,              // nor is it a summons
    detect: [/\bsummons\b|citaci[oó]n judicial/i, /\b(complaint|plaintiff|demandante)\b/i, /\b(30|thirty) (calendar )?days\b/i],
    not: /unlawful detainer|eviction|desalojo/i,
    spoken: /\b(su(ed|ing) me|being sued|lawsuit|debt collector|collection agency|credit card company)\b.*\b(summons|papers|court)\b|\b(summons|court papers)\b.*\b(debt|money|owe|credit card|collection|lawsuit|sued|suing)\b|^(?!.*\b(landlord|rent|evict\w*|lease)\b).*\bserved (me |you )?with (court |legal )?papers\b.*\b(debt|collect\w*|credit card)\b|\bcollections?\b.*\b(summons|court papers)\b|^(?!.*\b(landlord|rent|evict\w*|lease)\b).*\b(debt collector|collection agency|collections?|credit card company)\b.{0,40}(?<!\b(may|might|could) have )\b(sued|is suing|are suing) me\b/i,
    answers: /\b(money|debt|owe|lawsuit|sued|suing|collect\w*|credit card|loan|bill)\b/i,
    keyterms: ["summons", "complaint", "lawsuit", "debt collector"],
    headline: "File a written response with the court",
    steps: [
      "File a written response, usually an Answer, with the court within 30 days of being served. If you don't, the other side can win by default and may be able to take money from your wages or bank account.",
      "Court fees can be waived if you qualify (form FW-001).",
      "If the papers were left with someone else or mailed to you, service takes longer to complete, so you usually get extra days. This count assumes they were handed to you.",
      "Your court's self-help center can help you fill in the Answer for free, and so can legal aid.",
    ],
    help: [SELFHELP, LSNC, LAWHELP, TWO11],
    sources: ["Code of Civil Procedure § 412.20(a)(3) (a written response within 30 days after service)",
              "Code of Civil Procedure § 12 (the day of service does not count)",
              "Code of Civil Procedure §§ 12a and 135 (a last day on a weekend or court holiday moves to the next court day)"],
  }),
  spec({
    id: "jury-summons",
    family: "court",
    title: "A jury summons",
    plain: "A court's summons to serve on a jury.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "A jury summons prints its own date to respond or to report, and that's the date that counts.",
    must: /\bjur(y|or|ors)\b/i,
    detect: [/\bjur(y|or|ors)\b/i, /\bsummons\b/i, /\b(report|respond|juror number|jury service)\b/i],
    spoken: /\bjur(y|or)\b/i,
    answers: /\bjur(y|or)\b/i,
    keyterms: ["jury summons", "jury duty", "juror"],
    headline: "Respond to the court by the date on the summons",
    steps: [
      "Respond by the date on the summons, online or by phone, with the juror number printed on it.",
      "If the date doesn't work, you can usually postpone once. If serving would be a real hardship, ask to be excused and say why.",
      "Don't ignore it: the court can fine a juror who doesn't respond.",
    ],
    help: [JURY, SELFHELP, TWO11],
    sources: ["Code of Civil Procedure § 209 (a summoned juror who fails to respond can be fined)",
              "California Rules of Court, rule 2.1004 (a one-time postponement) and rule 2.1008 (excuse for undue hardship, in writing)"],
  }),
  // ---- traffic: tickets and a DMV suspension after a DUI arrest -------------------------------------------------
  spec({
    id: "ca-traffic-ticket",
    family: "traffic",
    title: "California: a traffic ticket or a courtesy notice from the traffic court",
    plain: "A traffic citation (a Notice to Appear) from an officer, or the court's courtesy notice about it. Not a parking ticket.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "A traffic ticket prints its own date to appear by, and that's the date that counts, unless the court has given you a later one in writing.",
    must: /\b(traffic|speeding|notice to appear|courtesy notice|moving violation|red light|citation)\b/i,
    // Not a parking ticket, and not what comes after a missed date (a failure to appear or a civil assessment has
    // its own rules), or a court date for something else.
    not: /\bparking\b|fail(ed|ure) to appear|\bFTA\b|civil assessment|\bwarrant\b|\b(missed|didn't (go|show)|did not (go|appear|show))\b.*\b(court|date|appear\w*)\b|\b(evict\w*|landlord|jury|small claims)\b/i,
    detect: [/\b(traffic|speeding|moving violation|red light|vehicle code)\b/i, /notice to appear|courtesy notice|citation/i, /\b(appear|appearance date|bail|pay|traffic court|trial by (written )?declaration)\b/i],
    spoken: /^(?=.*\b(traffic|speeding|red light|moving violation|courtesy notice|pulled (me )?over)\b)/is,
    answers: /\b(traffic|speeding|red light|moving|driving)\b/i,
    keyterms: ["traffic ticket", "courtesy notice", "trial by written declaration"],
    headline: "Act by the appearance date on your ticket",
    steps: [
      "Act by that date: pay, go to court, or ask for a trial. A courtesy notice from the court may show that date or a later one. If none comes, the ticket's date still counts.",
      "To fight it by mail (a trial by written declaration), make sure the court gets your written request by the appearance date on the ticket. The clerk then extends that date by 25 calendar days and sends the TR-205 form: file it and deposit the bail by the new date.",
      "If you can't pay, ask the court clerk what your options are. Don't let the date pass: that can add penalties.",
    ],
    help: [SELFHELP, LAWHELP, TWO11],
    sources: ["California Rules of Court, rule 4.210(b) (a request for a trial by written declaration by the appearance date extends it 25 days; the TR-205 form and bail are due by the appearance date or the extended date)",
              "Vehicle Code § 40902(a)–(b) (a trial by written declaration for most traffic infractions, with bail submitted with the declaration)",
              "California Courts Self-Help Guide, Traffic (without a courtesy notice, act by the date on the citation)"],
  }),
  spec({
    id: "ca-dmv-aps",
    family: "traffic",
    title: "DMV: a license suspension after a DUI arrest (admin per se)",
    plain: "The DMV's order suspending your license after a DUI arrest, often a pink notice the officer handed you.",
    anchor: "received",
    dateLabel: "Date you got the notice (often the day of the arrest)",
    dateQuestion: "What day did you get the suspension notice? It's often the day of the arrest. You can say something like September 13th.",
    count: { days: 10, unit: "calendar", roll: "none" },
    note: "I count 10 calendar days and don't extend it for a weekend or holiday, so this is the safe date to go by.",
    // An admin per se order after a DUI arrest only: not a suspension for unpaid tickets, a failure to appear,
    // points, or no insurance, which have their own rules.
    must: /admin(istrative)? per se|\bAPS\b|pink (notice|paper|slip)|\b(DUI|driving under the influence|blood alcohol|chemical test|breath(alyzer)? test|breathalyzer|refus\w* (the |a |to take (the |a )?)?(test|breath\w*|blood test|chemical test))\b/i,
    not: /unpaid (tickets?|fines?)|fail(ed|ure) to appear|\bFTA\b|\bpoints\b|negligent operator|\binsurance\b|financial responsibility|child support|\bregistration\b/i,
    detect: [/\b(DMV|department of motor vehicles|driver safety)\b/i, /suspen\w*|revo\w*|admin(istrative)? per se/i, /\b(DUI|driving under the influence|blood alcohol|chemical test|hearing)\b/i],
    spoken: /admin(istrative)? per se|pink (notice|paper|slip)|^(?=.*\b(dmv|license|licence)\b)(?=.*\b(dui|drunk|blood alcohol|breath(alyzer)? test|refused (the )?test)\b)/is,
    answers: /\b(dmv|dui|license|licence|per se)\b/i,
    keyterms: ["admin per se", "DMV hearing", "Driver Safety"],
    headline: "Ask the DMV for a hearing",
    steps: [
      "Call the DMV Driver Safety office on the notice and ask for a hearing, within 10 days of getting it. Write down when you called and who you talked to.",
      "For this kind of suspension, asking in time means the DMV has to hold the hearing and decide before the suspension starts, or put the suspension on hold until it decides. Asking doesn't stop the suspension by itself.",
      "The DMV hearing is separate from the criminal case. Ask the public defender or a lawyer about both.",
    ],
    help: [LAWHELP, TWO11],
    sources: ["Vehicle Code § 13558(b) (to have a hearing before the suspension takes effect, ask within 10 days of receiving the notice), (d) (a request postmarked or received within 10 days gets a hearing before the effective date) and (e) (a request doesn't stay the suspension, but the DMV must stay it if it misses that hearing)"],
  }),
  // ---- traffic: parking tickets (Vehicle Code § 40215) -------------------------------------------------------
  spec({
    id: "ca-parking-ticket",
    family: "traffic",
    title: "California: a parking ticket (notice of parking violation)",
    plain: "A parking ticket left on your car, or mailed to you, by a city, county or other agency.",
    anchor: "issued",
    dateLabel: "Date the ticket was issued (printed on it)",
    dateQuestion: "What date is on the ticket? You can say something like September 13th.",
    count: { days: 21, unit: "calendar", roll: "none" },
    must: /\bpark(ing|ed)?\b/i,
    not: /delinquen|results? of (the |your )?(initial )?review|administrative hearing/i,
    detect: [/notice of parking violation|parking (citation|ticket)/i, /\b(violation|citation|penalty)\b/i, /\b(contest|initial review|pay by|due date)\b/i],
    spoken: /\bparking (ticket|citation|violation)\b|\bticket\b.*\b(parked|parking)\b|\b(parked|parking)\b.*\bticket\b/i,
    answers: /\bpark(ing|ed)?\b/i,
    keyterms: ["parking ticket", "parking citation", "initial review"],
    headline: "Ask the agency for a free review, or pay",
    steps: [
      "To fight the ticket, ask the agency that gave it for an initial review within 21 days of the date it was issued. The review is free, and you can ask by phone, in writing or in person.",
      "If you'll pay it, pay by the date on the ticket, so late penalties aren't added.",
      PAYPLAN,
    ],
    help: [PARKING_AGENCY, LAWHELP, TWO11],
    sources: ["Vehicle Code § 40215(a) (21 calendar days from the issuance of the notice to request an initial review)",
              "Vehicle Code § 40220(a) (before an agency files an unpaid ticket with the DMV, it must offer a person who is indigent, as defined there, a payment plan; for $500 or less in penalties and fees, no more than $25 a month)"],
  }),
  spec({
    id: "ca-parking-delinquent",
    family: "traffic",
    title: "California: a late notice for a parking ticket (notice of delinquent parking violation)",
    plain: "A mailed notice that a parking ticket is unpaid and penalties are being added.",
    anchor: "mailed",
    dateLabel: "Date the notice was mailed (printed on it)",
    dateQuestion: "What date is printed on the notice? You can say something like September 13th.",
    count: { days: 14, unit: "calendar", roll: "none" },
    must: /\bpark(ing|ed)?\b/i,
    detect: [/delinquent parking violation|notice of delinquen/i, /\bpark(ing)?\b/i, /\b(penalt(y|ies)|unpaid|late fee)\b/i],
    spoken: /^(?=.*\b(late|delinquent|overdue|unpaid|past due)\b)(?=.*\bpark(ing|ed)\b)/is,   // any order
    answers: /\b(late|delinquent|overdue|unpaid|past due)\b/i,
    keyterms: ["delinquent parking violation"],
    headline: "Ask for a free review, or pay",
    steps: [
      "You can still ask the agency for an initial review within 14 days of the date this notice was mailed. It's free: by phone, in writing or in person.",
      "Or pay it now, before more penalties are added.",
      PAYPLAN,
    ],
    help: [PARKING_AGENCY, LAWHELP, TWO11],
    sources: ["Vehicle Code § 40215(a) (14 calendar days from the mailing of a notice of delinquent parking violation)",
              "Vehicle Code § 40220(a) (before an agency files an unpaid ticket with the DMV, it must offer a person who is indigent a payment plan)"],
  }),
  spec({
    id: "ca-parking-review",
    family: "traffic",
    title: "California: the result of a parking ticket review (you can ask for a hearing)",
    plain: "A letter with the result of the initial review you asked for, if you still disagree.",
    anchor: "mailed",
    dateLabel: "Date the review result was mailed (printed on it)",
    count: { days: 21, unit: "calendar", roll: "none" },
    must: /\bpark(ing|ed)?\b/i,
    detect: [/\binitial review\b|\breview (result|decision)/i, /\badministrative hearing\b/i, /\bpark(ing)?\b/i],
    spoken: /^(?=.*\b(review|appeal)\b)(?=.*\b(denied|result|decision|lost|upheld|turned down)\b)(?=.*\bpark(ing|ed)\b)/is,   // any order
    answers: /\b(review|hearing|denied|result|decision)\b/i,
    keyterms: ["administrative hearing"],
    headline: "Ask for an administrative hearing",
    steps: [
      "Ask the agency for an administrative hearing within 21 days of the date the review result was mailed.",
      "You'll usually have to pay the ticket amount first, as a deposit. If you have a low income or get public benefits and can show you can't pay, the agency has to let you ask for the hearing without paying.",
      PAYPLAN,
    ],
    help: [PARKING_AGENCY, LAWHELP, TWO11],
    sources: ["Vehicle Code § 40215(b) (21 calendar days after the review result is mailed; the penalty is deposited first, but the agency must let a person who is indigent, as defined in § 40220, ask for a hearing without paying, on proof of inability to pay)"],
  }),
  // ---- Social Security: an overpayment --------------------------------------------------------------------------
  spec({
    id: "ssa-overpayment",
    family: "ssa",
    title: "Social Security: an overpayment notice (they say they paid you too much)",
    plain: "A notice that Social Security or SSI says it paid you too much and wants the money back.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 60, unit: "calendar", mail: 5, roll: "federal" },
    mailWho: "Social Security",
    must: /overpa(id|yment)/i,
    detect: [/overpa(id|yment)/i, /social security|supplemental security income|\bSSI\b/i, /\b(waiver|reconsideration|repay|pay (us )?back)\b/i],
    spoken: /^(?=.*\b(overpaid|overpayment|paid (me )?too much|pay (it |them |that |the money )?back)\b)(?=.*\b(social security|ssi|ssdi|ssa)\b)/is,
    answers: /\b(overpaid|overpayment|too much|pay (it )?back)\b/i,
    keyterms: ["overpayment", "waiver", "Supplemental Security Income"],
    headline: "Appeal it if it's wrong, or ask for a waiver",
    also: [{ label: "For Social Security benefits (not SSI), ask by {date}, 30 days after the date on the notice, and they won't start taking money back while they decide.", days: 30 }],
    steps: [
      "If you weren't overpaid, or the amount is wrong, ask for reconsideration (form SSA-561). If it wasn't your fault and paying it back would be too hard, ask for a waiver (form SSA-632). You can ask for both.",
      "If you get SSI and the notice lowers or stops your payments, appeal within 10 days of getting it, and your payments stay the same while Social Security decides.",
      "Keep proof of when you asked.",
    ],
    help: [LSNC, LAWHELP, TWO11, SSA],
    sources: ["20 CFR 404.909 and 416.1409 (reconsideration within 60 days after you receive the notice)",
              "20 CFR 404.901 and 416.1401 (notice presumed received 5 days after its date)",
              "20 CFR 404.3(b) and 416.120(d) (a last day on a weekend or federal holiday moves to the next workday)",
              "20 CFR 404.502a and 404.506(c) (Social Security benefits: recovery doesn't start on a waiver or reconsideration request within 30 days)",
              "20 CFR 416.1336(b) (SSI: payments continue on an appeal within 10 days after receipt)"],
  }),
  spec({
    id: "ssa-appeals-council",
    family: "ssa",
    title: "Social Security: a judge's decision against you (you can ask the Appeals Council)",
    plain: "An unfavorable decision, or a dismissal, after a hearing with a Social Security judge.",
    anchor: "notice",
    dateLabel: "Date printed on the decision",
    count: { days: 60, unit: "calendar", mail: 5, roll: "federal" },
    mailWho: "Social Security",
    must: /appeals council|hearing decision|administrative law judge|\bALJ\b/i,
    // Another court's hearing that went against a caller on Social Security (custody, criminal, immigration…) isn't the
    // Appeals Council's, unless the text names a Social Security appeal.
    not: /^(?!.*\b(appeals council|ALJ|administrative law judge|(social security|ssa|ssi|ssdi|disability) judge|(disability|ssi|ssdi|social security) (claim|case|appeal|hearing)|(claim|case|appeal|hearing) (for|about) (my )?(disability|ssi|ssdi|social security))\b)(?=.*\b(custody|family court|criminal|bail|immigration|asylum|deport\w*|small claims|traffic court)\b)/is,
    detect: [/appeals council/i, /\b(hearing decision|administrative law judge|unfavorable|dismiss\w*)\b/i, /social security|supplemental security income|\bSSI\b/i],
    spoken: /\bappeals council\b|^(?=.*\b(social security|ssi|ssdi|disability)\b)(?=.*\b(judge|hearing|alj)\b)(?=.*\b(denied|lost|unfavorable|said no|turned (me )?down|against me|dismiss\w*)\b)/is,
    answers: /\b(judge|hearing|appeals council|decision)\b/i,
    keyterms: ["Appeals Council", "hearing decision"],
    headline: "Ask the Appeals Council to review the decision",
    steps: [
      "Ask for Appeals Council review, online at ssa.gov or with form HA-520. It's free.",
      "Keep proof of when you asked.",
      "If you missed it, you can still ask for more time in writing and explain why (good cause).",
    ],
    help: [LSNC, LAWHELP, TWO11, SSA],
    sources: ["20 CFR 404.968(a)(1) and 416.1468(a) (within 60 days after you receive the notice of the hearing decision or dismissal)",
              "20 CFR 404.901 and 416.1401 (notice presumed received 5 days after its date)",
              "20 CFR 404.3(b) and 416.120(d) (a last day on a weekend or federal holiday moves to the next workday)"],
  }),
  spec({
    id: "ssa-benefits-ending",
    family: "ssa",
    title: "Social Security or SSI: your benefits will stop or go down (keep them while you appeal)",
    plain: "A notice that your SSI will be cut, suspended or stopped, or that disability benefits will end because Social Security says you're no longer disabled.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 10, unit: "calendar", mail: 5, roll: "none" },
    mailWho: "Social Security",
    must: /suspen|reduc|terminat|stop|cease|cessation|ending|no longer disabled/i,
    not: /overpa(id|yment)/i,
    detect: [/\b(suspen\w*|reduc\w*|terminat\w*|stop\w*|cease\w*|cessation)\b|no longer disabled/i, /social security|supplemental security income|\bSSI\b|disability/i, /\b(continu\w*|10 days|ten days|appeal)\b/i],
    spoken: /^(?=.*\b(ssi|social security|ssdi|disability)\b)(?=.*\b(cut\w*|stopp\w*|stop|ending|end|suspend\w*|reduc\w*|going down|terminat\w*|cessation|no longer disabled)\b)/is,
    answers: /\b(stop\w*|cut\w*|ending|reduc\w*|keep|going down)\b/i,
    keyterms: ["continued benefits", "cessation", "suspension"],
    headline: "Appeal, and ask to keep your benefits while you do",
    also: [{ label: "To appeal at all, you have until {date}, 60 days after you get the notice. After the earlier date, your payments usually stop while you wait, unless you have a good reason for being late.", days: 60, mail: 5 }],
    steps: [
      "By this date, appeal in writing. For an SSI cut or stop, appealing in time is usually enough to keep your payments going.",
      "If it's your disability that's ending, the appeal alone isn't enough: in the same request, ask for reconsideration and say that you want your benefits to continue.",
      "If you're late, ask anyway and explain why: a good reason can still count.",
      "If you lose the appeal, you may have to pay back what you got while waiting.",
      "For retirement, survivors or other benefits that aren't about disability, appealing doesn't keep payments going.",
    ],
    help: [LSNC, LAWHELP, TWO11, SSA],
    sources: ["20 CFR 416.1336(b) (SSI: payments continue on an appeal within 10 days after receipt)",
              "20 CFR 404.1597a(f)(1) and (g)(1), and 416.996(c) for SSI (disability ending: ask for reconsideration or a hearing and for continued benefits within 10 days after receipt; later, only for good cause)",
              "20 CFR 404.901 and 416.1401 (receipt presumed 5 days after the notice date)"],
  }),
  // ---- unemployment -----------------------------------------------------------------------------------------------
  spec({
    id: "ca-edd-determination",
    family: "unemployment",
    title: "EDD: a Notice of Determination or Notice of Overpayment about unemployment benefits",
    plain: "A letter from California's Employment Development Department denying or cutting unemployment benefits, or saying you were overpaid.",
    anchor: "mailed",
    dateLabel: "Mailing date printed on the notice",
    dateQuestion: "What's the mailing date on the notice? You can say something like September 13th.",
    count: { days: 30, unit: "calendar", roll: "none" },
    must: /\bEDD\b|employment development department|unemployment insurance/i,
    not: /^(?!.*\b(unemployment|DE 1000M)\b).*\b(disability insurance|state disability|SDI|paid family leave|PFL|DE 2517|DE 2514|DE 8517)\b/is,
    detect: [/\bEDD\b|employment development department/i, /notice of (determination|overpayment)|disqualif|ineligible|not eligible/i, /\b(appeal|unemployment insurance|DE 1000M)\b/i],
    spoken: /^(?=.*\b(edd|unemployment)\b)(?=.*\b(denied|disqualif\w*|not eligible|ineligible|stopped|cut off|turned (me )?down|determination|overpaid|overpayment|pay (it )?back)\b)/is,
    answers: /\b(edd|unemployment|jobless)\b/i,
    keyterms: ["EDD", "Employment Development Department", "unemployment", "Notice of Determination", "Notice of Overpayment"],
    note: "EDD counts the 30 days from the mailing date on the notice.",
    headline: "Appeal to the Unemployment Insurance Appeals Board",
    steps: [
      "Appeal within 30 days of the mailing date on the notice. Use the appeal form that came with it (DE 1000M), or a letter saying you disagree and why, and mail it to the address at the top of the notice.",
      "If you're late, appeal anyway and say why: the 30 days can be extended for good cause.",
    ],
    help: [EDD, LAWHELP, TWO11],
    sources: ["Unemployment Insurance Code § 1328 (a determination: 30 days from service of the notice; extended for good cause)",
              "Unemployment Insurance Code § 1377 (a Notice of Overpayment: 30 days from the date it was mailed or served; extended for good cause)",
              "EDD, Unemployment Insurance Appeals (30 days from the mail date of the notice; form DE 1000M)"],
  }),
  spec({
    id: "ca-edd-sdi",
    family: "unemployment",
    title: "EDD: State Disability Insurance or Paid Family Leave denied (a Notice of Determination)",
    plain: "A letter from California's Employment Development Department saying you can't get disability (SDI) or Paid Family Leave benefits.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 30, unit: "calendar", roll: "none" },
    must: /\b(disability insurance|state disability|SDI|paid family leave|PFL|DE 2517|DE 2514|DE 8517)\b/i,
    not: /\bunemployment\b|DE 1000M/i,
    detect: [/\bEDD\b|employment development department/i, /\b(disability insurance|state disability|SDI|paid family leave|PFL)\b/i, /notice of determination|DE 2517|DE 2514|DE 8517|not eligible|ineligible|disqualif|\bappeal\b/i],
    spoken: /^(?=.*\b(sdi|state disability|disability insurance|paid family leave|pfl|family leave)\b|.*\bedd\b.*\bdisability\b|.*\bdisability\b.*\bedd\b)(?=.*\b(denied|not eligible|ineligible|disqualif\w*|stopped|cut off|turned (me )?down|determination)\b)(?!.*\bunemployment\b)(?!(?:(?!\bedd\b|employment development).)*\b(social security|ssi|ssdi)\b)/is,
    answers: /\b(sdi|state disability|disability insurance|paid family leave|pfl|family leave)\b/i,
    keyterms: ["State Disability Insurance", "SDI", "Paid Family Leave"],
    note: "EDD counts the 30 days from the date the notice was issued.",
    headline: "Appeal to an administrative law judge",
    steps: [
      "Appeal within 30 days of the date on the notice, online in myEDD or in writing. Online is fastest: mail can be postmarked later than the day you drop it off.",
      "If you're late, appeal anyway and say why: the 30 days can be extended for good cause.",
      "If your benefits come from your employer's own plan (a voluntary plan), appeal by sending a letter to your local EDD field office. You have the right to a hearing before a judge.",
    ],
    help: [EDD, LAWHELP, TWO11],
    sources: ["Unemployment Insurance Code § 2707.2(a) (a disability determination: appeal to an administrative law judge within 30 days from service of the notice; extended for good cause)",
              "EDD, State Disability Insurance Appeals (DI or PFL: appeal within 30 days of the date the notice was issued; a late appeal must give the reasons; the Notice of Determination is DE 2517 for DI and DE 2514 for PFL; a voluntary plan's denial is appealed by a letter to the local EDD field office, with a hearing before a judge)"],
  }),
  // ---- benefits: a Medi-Cal health plan's appeal decision -----------------------------------------------------------
  spec({
    id: "ca-medi-cal-plan",
    family: "benefits",
    title: "Medi-Cal health plan: your appeal was denied (Notice of Appeal Resolution)",
    plain: "A letter from your Medi-Cal managed care plan saying it kept its decision after your appeal.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 120, unit: "calendar", roll: "none" },
    must: /^(?=.*medi-?cal)(?=.*(notice of appeal resolution|\bappeal\b))/is,   // the plan's answer to an appeal
    detect: [/notice of appeal resolution/i, /medi-?cal/i, /\b(health plan|managed care|state hearing)\b/i],
    spoken: /^(?=.*\bmedi-?cal\b)(?=.*\b(health plan|managed care|my plan|insurance plan|medi-?cal plan)\b)(?=.*\bappeal\b)(?=.*\b(denied|upheld|said no|lost|turned (it )?down)\b)/is,
    answers: /\b(health plan|managed care|plan|appeal)\b/i,
    keyterms: ["Notice of Appeal Resolution", "managed care plan", "State Hearing"],
    headline: "Ask for a State Hearing",
    steps: [
      "Ask for a State Hearing within 120 days: call (800) 743-8525, or send the hearing form that came with the notice.",
      "Write down the date you asked and who you talked to.",
      "You can bring someone to help you, including free legal aid.",
    ],
    help: [STATE_HEARINGS, LSNC, LAWHELP, TWO11],
    sources: ["Welfare and Institutions Code § 10951 (a State Hearing within 120 calendar days after the plan's notice that it upheld its decision; good cause up to 180 days)",
              "42 CFR 438.408(f)(2) (120 calendar days from the date of the plan's notice of resolution)"],
  }),
  spec({
    id: "ca-medi-cal-plan-denial",
    family: "benefits",
    title: "Medi-Cal health plan: a denial of care or a service (Notice of Adverse Benefit Determination)",
    plain: "A letter from your Medi-Cal managed care plan denying, cutting or stopping a treatment, a medicine or a service.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 60, unit: "calendar", roll: "none" },
    must: /medi-?cal/i,
    not: /notice of appeal resolution/i,
    detect: [/adverse benefit determination|notice of action/i, /\b(health plan|managed care)\b/i, /\b(appeal|grievance)\b/i],
    spoken: /^(?=.*\bmedi-?cal\b)(?=.*\b(health plan|managed care|my plan|insurance plan|medi-?cal plan)\b)(?=.*\b(denied|won't (cover|pay)|not cover|refused|cut|stopped|said no)\b)/is,
    answers: /\b(plan|care|medicine|service|treatment|surgery|doctor)\b/i,
    keyterms: ["Notice of Adverse Benefit Determination", "health plan"],
    headline: "Appeal to your health plan",
    steps: [
      "Appeal to your Medi-Cal health plan within 60 days of the date on the notice: call the plan's member services number, or send the appeal form that came with the notice.",
      "If the plan says no again, it sends a Notice of Appeal Resolution, and then you have 120 days to ask for a State Hearing.",
      "If the plan misses its own deadlines for your appeal, you can ask for a State Hearing without waiting.",
      "If waiting could seriously harm your health, ask the plan for an expedited appeal.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["42 CFR 438.402(c)(2)(ii) (60 calendar days from the date on the notice to appeal to the plan)",
              "42 CFR 438.402(c)(1)(i) and 438.408 (a State Hearing after the plan upholds its decision, or at once if the plan misses its notice or timing rules: 438.408(c)(3))",
              "42 CFR 438.410 (expedited appeals)"],
  }),
  // ---- housing: notices that end a tenancy or raise the rent ------------------------------------------------------
  ...[30, 60].map(days => spec({
    id: `ca-${days}day-notice`,
    family: "housing",
    title: `California: a ${days}-day notice to move out (termination of tenancy)`,
    plain: days === 60 ? "A landlord's notice ending a month-to-month tenancy, for a tenant who has lived there a year or more."
      : "A landlord's notice ending a month-to-month tenancy, for a tenant who has lived there less than a year.",
    confidence: "HEDGE",
    anchor: "served",
    dateLabel: "Date the notice was handed to you",
    dateQuestion: "What day was the notice handed to you? You can say something like September 13th.",
    count: { days, unit: "calendar", roll: "none" },
    lead: `A ${days}-day notice can't end your tenancy before {date}`,
    note: "This counts from the day the notice was handed to you. If it came by mail, the earliest end date may be later.",
    must: days === 60 ? /\b(60|sixty)\b/i : /\b(30|thirty)\b/i,
    not: days === 60 ? /\b(30|thirty)[- ]day notice\b/i : /\b(60|sixty)[- ]day notice\b/i,
    detect: [days === 60 ? /\b(60|sixty)[- ]day notice\b|sixty \(60\) days/i : /\b(30|thirty)[- ]day notice\b|thirty \(30\) days/i,
      /terminat\w* (of )?(your )?tenancy|notice to (vacate|quit|move out)/i, /\b(landlord|owner|tenant|premises)\b/i],
    spoken: days === 60 ? /\b(60|sixty)[- ]day notice\b/i : /\b(30|thirty)[- ]day notice\b/i,
    answers: days === 60 ? /\b(60|sixty)\b/i : /\b(30|thirty)\b/i,
    keyterms: [`${days}-day notice`, "termination of tenancy"],
    headline: "Get free legal help to check the notice, and plan for that date",
    steps: [
      "This notice isn't an eviction order. If you're still there after that date, the landlord has to go to court, and you'll get court papers you can answer.",
      days === 30 ? "If you've lived there a year or more, the landlord usually has to give 60 days' notice, not 30."
        : "The landlord has to give at least 60 days' notice to a tenant who has lived there a year or more.",
      "If you've lived there 12 months or more, many California landlords need a legal reason (just cause), and for some reasons they owe you one month's rent to help you move. Ask legal aid whether yours is valid.",
    ],
    help: [LSNC, LAWHELP, SELFHELP, TWO11],
    sources: ["Civil Code § 1946.1(b)–(d) (60 days' notice for a tenant of a year or more, 30 days for less, with a sale exception) and (f) (served in person or by certified or registered mail)",
              "Civil Code § 1946.2 (after 12 months, many tenancies can end only for just cause; one month's rent for a no-fault termination)"],
  })),
  spec({
    id: "ca-rent-increase",
    family: "housing",
    title: "California: a notice that your rent is going up",
    plain: "A landlord's written notice of a rent increase on a month-to-month tenancy.",
    confidence: "HEDGE",
    anchor: "served",
    dateLabel: "Date the notice was handed to you",
    dateQuestion: "What day was the notice handed to you? You can say something like September 13th.",
    count: { days: 30, unit: "calendar", roll: "none" },
    lead: "If the increase is 10 percent or less, the new rent can't start before {date}",
    also: [{ label: "If it's more than 10 percent, it can't start before {date}, 90 days after you got the notice.", days: 90 }],
    note: "If the notice came by mail, add 5 days to each date.",
    must: /^(?=.*\brent(al)?\b)(?=.*\bincrease)/is,
    detect: [/\b(rent|rental)\b/i, /\bincrease\b/i, /\b(notice|effective)\b/i],
    spoken: /^(?=.*\brent\b)(?=.*\b(increas\w*|going up|goes up|raise\w*|raising|higher)\b)/is,
    answers: /\b(rent|increase|raise|going up)\b/i,
    keyterms: ["rent increase"],
    headline: "Keep paying your current rent until the new rent can start",
    steps: [
      "A rent increase needs written notice: at least 30 days for 10 percent or less over the past year, at least 90 days for more.",
      "Many California rentals can't go up more than 5 percent plus inflation, and never more than 10 percent, in a year, and some cities limit it more. Ask legal aid if yours looks higher.",
      "Keep paying your current rent until the new rent can start.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["Civil Code § 827(b) (30 days' notice for an increase of 10 percent or less over the past 12 months, 90 days for more; 5 more days if mailed, Code of Civil Procedure § 1013)",
              "Civil Code § 1947.12(a)(1) (for many rentals, no more than 5 percent plus the change in the cost of living, or 10 percent, whichever is lower, in 12 months)"],
  }),
  spec({
    id: "ca-sheriff-vacate",
    family: "housing",
    title: "California: a sheriff's Notice to Vacate (after an eviction judgment)",
    plain: "A notice from the sheriff, with a writ of possession, after the court ruled for the landlord in an eviction case.",
    confidence: "HEDGE",
    anchor: "served",
    dateLabel: "Date the sheriff's notice was handed to you or posted",
    dateQuestion: "What day was the sheriff's notice handed to you or posted on your door? You can say something like September 13th.",
    count: { days: 5, unit: "calendar", roll: "court" },
    lead: "You have until {date} to move out",
    note: "If the notice prints an earlier date to be out by, call legal aid right away and plan for the earlier one. If it was posted and mailed, the 5 days can start before you find it, so don't wait.",
    must: /\bsheriff\b|writ of possession|marshal|levying officer/i,
    detect: [/\bsheriff\b|marshal|levying officer/i, /writ of possession|notice to vacate/i, /\b(five|5) days\b|\bvacate\b|\bremov\w*/i],
    spoken: /\b(sheriff|marshal)\b.*\b(notice|vacate|lock|out|writ|door|remove)\b|\bwrit of possession\b|\blevying officer\b/i,
    answers: /\b(sheriff|writ|lock\w*|marshal)\b/i,
    keyterms: ["writ of possession", "sheriff", "Notice to Vacate"],
    headline: "After that, the sheriff can lock you out. Call free legal aid today about asking the court for more time",
    steps: [
      "Call legal aid today about asking the court to stop or delay the lockout, or getting the landlord to hold off. Act right away: asking doesn't stop the lockout by itself, and the court may say no.",
      "Mailing doesn't add days to the 5. Plan where you'll go, and take your important papers, medicine and pets.",
      "Things you leave behind are stored for a short time, and you'll get a notice about how to get them back.",
    ],
    help: [LSNC, SELFHELP, LAWHELP, TWO11],
    sources: ["Code of Civil Procedure § 715.020(a)–(c) (the levying officer serves the writ on an occupant, or posts it and serves the judgment debtor; occupants who don't leave within 5 days from service are removed; § 684.120's extra time for mailing doesn't apply)",
              "Code of Civil Procedure §§ 12 and 12a (the day of service doesn't count; a last day on a weekend or court holiday moves to the next court day)"],
  }),
  spec({
    id: "ca-subsidy-end",
    family: "housing",
    title: "California: your landlord is ending a rent subsidy contract (such as Section 8)",
    plain: "A notice that the owner is ending or not renewing a Section 8 or other government rent-subsidy contract for your home.",
    anchor: "received",
    dateLabel: "Date you got the notice",
    dateQuestion: "What day did you get the notice? You can say something like September 13th.",
    count: { days: 90, unit: "calendar", roll: "none" },
    lead: "Your landlord can't make you pay more than your share of the rent through {date}",
    // The owner ending the contract, not the housing authority ending a family's assistance (a different letter,
    // with a short window to ask for a hearing), and not a rent increase for a tenant who has a voucher.
    must: /^(?=.*(section 8|section eight|housing choice voucher|\bvoucher\b|\bHAP\b|housing assistance payment|subsid\w*|rent limitation))(?=.*\b(leav\w* (section 8|section eight|the program)|opt(s|ing|ed)?[- ]out|not (renew|continu)\w*|won't renew|nonrenew\w*|no longer (take|accept)\w*|stop\w* (taking|accepting)|(terminat|end)\w* (the |my |its |our )?(section 8 |section eight |hap |subsidy |voucher |housing assistance payments? )?(contract|agreement)))/is,
    not: /\b(housing authority|PHA)\b|\bmy voucher\b.*\bterminat|\bterminat\w*\b.*\bmy voucher\b/i,
    detect: [/section 8|housing choice voucher|\bvoucher\b|\bHAP\b|housing assistance payment|subsid\w*/i, /leav\w* (section 8|section eight|the program)|opt(s|ing|ed)?[- ]out|not (renew|continu)\w*|won't renew|nonrenew\w*|no longer (take|accept)\w*|stop\w* (taking|accepting)|(terminat|end)\w* (the |my |its |our )?(section 8 |section eight |hap |subsidy |voucher |housing assistance payments? )?(contract|agreement)/i, /\b(owner|landlord|contract|90 days|ninety)\b/i],
    spoken: /^(?!.*\b(housing authority|pha)\b)(?!.*\bmy voucher\b.*\bterminat)(?!.*\bterminat\w*\b.*\bmy voucher\b)(?=.*\b(section 8|section eight|voucher|subsid\w*|housing assistance)\b)(?=.*\b(leav\w* (section 8|section eight|the program)|opt(s|ing|ed)?[- ]out|not (renew|continu)\w*|won't renew|nonrenew\w*|no longer (take|accept)\w*|stop\w* (taking|accepting)|(terminat|end)\w* (the |my |its |our )?(section 8 |section eight |hap |subsidy |voucher |housing assistance payments? )?(contract|agreement)))/is,
    answers: /\b(section 8|section eight|voucher|subsid\w*)\b/i,
    keyterms: ["Section 8", "housing choice voucher", "subsidy contract"],
    headline: "Call your housing authority, and keep paying only your share of the rent",
    steps: [
      "Call your housing authority right away. If you have a voucher, ask how to keep using it, where you live now or somewhere new.",
      "The owner has to give at least 90 days' written notice before the contract ends. In some subsidized buildings (an \"assisted housing development\" under state law), the owner generally has to give 12 months' notice before the subsidy ends.",
      "If the owner asks for more than your share before that date, ask legal aid.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["Civil Code § 1954.535 (at least 90 days' written notice of the termination's effective date; the tenant pays no more than their portion of the rent for 90 days after getting the notice)",
              "Government Code § 65863.10(b)(1) (an assisted housing development: at least 12 months' notice before a subsidy contract ends, unless § 65863.13 exempts the owner)"],
  }),
  // ---- utilities: shutoff notices -------------------------------------------------------------------------------
  spec({
    id: "ca-utility-shutoff",
    family: "utilities",
    title: "California: a notice that your electricity or gas will be shut off for an unpaid bill",
    plain: "A past-due or disconnection notice from PG&E, Southern California Edison, SoCalGas, SDG&E or another private energy company.",
    confidence: "HEDGE",
    anchor: "mailed",
    dateLabel: "Date the notice was mailed (printed on it)",
    count: { days: 15, unit: "calendar", roll: "none" },
    lead: "A private utility can't shut off your service before {date}",
    note: "A private utility has to mail the notice at least 15 days before a shutoff, so this is the earliest a shutoff can happen, not the day it will. City and district utilities have their own notice rules.",
    // A nonpayment disconnection by a private energy company only: not a landlord (Civil Code § 789.3), not a
    // safety outage, not a city or district utility or propane (§ 779.1 doesn't cover them), not a past-due bill.
    must: /shut ?off|shut\w* (it |my \w+ )?off|disconnect\w*|terminat\w* (of )?(your )?service|turn\w* off|cut\w* off/i,
    not: /\b(landlord|owner|manager|PSPS|public safety|fire weather|wildfire|outage|propane|butane|SMUD|LADWP|municipal|utility district|irrigation district|department of water and power)\b|\bcity of [a-z]+( [a-z]+){0,2} (public utilities|utilities|electric( department| utility)?|light (and|&) power)\b|\bcity (utilities|electric|light and power)\b|\bwater (and|&) power\b|\bhousing authority\b|\bwater (service|bill|system|company|district|department|account)\b/i,
    detect: [/PG&E|pacific gas|edison|socalgas|SDG&E|\b(electric\w*|gas|energy|power)\b/i, /shut ?off|disconnect\w*|terminat\w*|48[- ]hour|turn\w* off|cut\w* off/i, /\b(notice|pay|payment|arrangement|balance|past due)\b/i],
    spoken: /^(?=.*\b(pg&e|pg and e|pge|edison|socalgas|sdg&e|electric\w*|power|gas|lights|utility|utilities)\b)(?=.*\b(shut\w* off|shutoff|disconnect\w*|turn\w* off|cut\w* off)\b)/is,
    answers: /\b(power|electric\w*|gas|pg&e|pge|edison|utility)\b/i,
    keyterms: ["PG&E", "disconnection notice", "shutoff notice"],
    headline: "Call the utility before that date and ask for a payment arrangement",
    steps: [
      "Call the utility before that date. Ask for a payment arrangement, and ask whether any programs lower your bill (such as CARE).",
      "If someone in your home has a serious medical condition, say so and ask whether medical protections apply.",
      "Before shutting it off, the utility has to try to reach you by phone or in person at least 24 hours ahead, or leave a notice at least 48 hours ahead.",
    ],
    help: [TWO11, LAWHELP],
    sources: ["Public Utilities Code § 779.1(a) (no shutoff for nonpayment without a mailed notice at least 10 days ahead; the 10 days start 5 days after it's mailed) and (b) (a try by phone or in person at least 24 hours ahead, or a notice at least 48 hours ahead)"],
  }),
  spec({
    id: "ca-water-shutoff",
    family: "utilities",
    title: "California: a notice that your water will be shut off for an unpaid bill",
    plain: "A past-due or shutoff notice from your water system about a home's water bill.",
    confidence: "HEDGE",
    anchor: "due",
    dateLabel: "Date the unpaid bill was due",
    dateQuestion: "When was the unpaid water bill due? You can say something like August 1st.",
    count: { days: 60, unit: "calendar", roll: "none" },
    lead: "Most water systems can't shut off your water before {date}",
    note: "This counts from the due date, so it's the earliest possible date: the 60 days run from when the bill became late, which may be a little later. It covers city water and most water companies and districts: since August 2024, any community water system (15 or more homes, or 25 year-round residents). A very small system may differ.",
    // A water shutoff for nonpayment: not a gas or electric shutoff that mentions hot water or a water heater (unless
    // it names the water service or bill), not a landlord, not an outage, not a past-due bill.
    must: /^(?=.*\bwater\b)(?=.*(shut ?off|shut\w* (it |my \w+ )?off|disconnect\w*|discontinu\w*|terminat\w*|turn\w* off|cut\w* off))/is,
    not: /^(?!.*\bwater (service|bill|system|company|district|department|account)\b).*\b(gas|socalgas|pg&e|pge|sdg&e|edison|electric\w*|power|water heater|hot water)\b|\b(landlord|owner|manager|housing authority|outage|main break|boil)\b/is,
    detect: [/\bwater\b/i, /shut ?off|disconnect\w*|discontinu\w*|terminat\w*|turn\w* off|cut\w* off/i, /\b(notice|pay|payment|bill|balance|past due)\b/i],
    spoken: /^(?=.*\bwater\b)(?=.*\b(shut\w* off|shutoff|disconnect\w*|turn\w* off|cut\w* off|discontinu\w*)\b)/is,
    answers: /\bwater\b/i,
    keyterms: ["water shutoff", "discontinuation of service"],
    headline: "Call the water system and ask about a payment plan",
    steps: [
      "Call the water system before that date. Ask for a payment plan. If the bill looks wrong, appeal it: while the appeal is pending, the water system can't shut off your water.",
      "At least 7 business days before a shutoff, the water system has to contact you by phone or in writing.",
      "If three things are true, the water system must offer you a payment arrangement instead of shutting off your water: a doctor or other primary care provider certifies that a shutoff would seriously threaten the health of someone who lives there, you can't pay within the normal billing cycle (someone gets Medi-Cal, CalFresh, CalWORKs, general assistance, SSI or WIC, or your household income is under twice the poverty level), and you agree to a payment plan. Keep up with the plan and your new bills to stay protected.",
    ],
    help: [TWO11, LAWHELP],
    sources: ["Health and Safety Code § 116908(a)(1) (a covered water system can't shut off a home's service until a payment is at least 60 days late, and must contact the customer at least 7 business days before; the notice gives the date to pay or make an arrangement) and (b) (no shutoff while an appeal of the bill is pending)",
              "Health and Safety Code § 116910(a) (no shutoff when a primary care provider certifies a serious threat to health, the customer can't pay in the normal billing cycle, and agrees to a payment plan) and (b) (the system offers a payment option; falling behind on it for 60 days or more can lead to a shutoff 5 business days after a posted final notice)",
              "Health and Safety Code §§ 116902 and 116904 (covered water systems, including every community water system from August 1, 2024) and 116275(i) (a community water system: at least 15 service connections or 25 yearlong residents)"],
  }),
  // ---- consumer: debt collectors and car repossession ------------------------------------------------------------
  spec({
    id: "debt-validation",
    family: "consumer",
    title: "A debt collector's first letter (a validation notice)",
    plain: "A collection agency's letter about a debt, with a date by which you can dispute it.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "A debt collector's validation notice prints a date to dispute the debt by. Dispute in writing by that date if you can. If the notice reached you late, you may have until 30 days after you got it.",
    must: /debt collect\w*|collection agency|collector|validation notice|\bcollections?\b/i,
    unhedge: true,              // "If you receive a summons, do not ignore it." isn't a suit
    // Not a lawsuit (court papers have their own deadline), and not a government agency collecting its own debt
    // (the IRS, FTB, EDD, Social Security, child support, a county or court): the validation rules cover debt collectors.
    // An actual suit (being sued, papers, a summons), not the boilerplate a validation notice carries ("if you are sued",
    // "we will not sue you", "the law limits how long you can be sued", "may be eligible for small claims").
    not: /\b((sued|sues|suing|took|taking|filed) me\b|filed (a|the) (suit|lawsuit|case)|summons|court papers|(a|the) complaint (was |has been )?filed|complaint against you|served (me |you )?with|(been|got) served|served papers|small claims (papers|court papers|claim|case|hearing)|plaintiff'?s claim|SC-?100)\b|\b(IRS|internal revenue|FTB|franchise tax|EDD|employment development|social security|SSA|SSI|child support|county|court (fines?|fees?|costs)|trash|garbage|recycling)\b/i,
    detect: [/debt collect\w*|collection agency|collector/i, /validation|dispute|verif\w*/i, /\b(owe|balance|creditor|debt)\b/i],
    spoken: /^(?!.*\b((sued|suing) me|filed (a|the) (suit|lawsuit|case)|summons|court papers)\b).*(debt collect\w*|collection agency|\b(sent|went|gone|turned over) (\w+ ){0,3}to collections\b|\bcollections? (letter|notice|agency|company)\b|validation notice)/is,
    answers: /\b(collect\w*|collector|debt)\b/i,
    keyterms: ["debt collector", "collection agency", "validation notice"],
    headline: "If you don't think you owe it, dispute it in writing by the date on the notice",
    steps: [
      "To dispute it, write to the collector by that date and say you dispute the debt and want proof. Keep a copy, and mail it in a way you can prove.",
      "Once you dispute in writing in time, the collector has to stop collecting until it mails you proof of the debt.",
      "If you're sued over the debt, you get court papers with their own deadline: use this tool again.",
    ],
    help: [LAWHELP, TWO11],
    sources: ["15 U.S.C. § 1692g(a)(3)–(4) and (b) (dispute within 30 days after receiving the notice; after a written dispute, collection stops until the collector mails verification)",
              "12 CFR 1006.34(b)(5) and (c) (the validation period ends 30 days after the consumer receives, or is assumed to receive, the notice, at least 5 days after it's sent, not counting weekends and federal holidays; the notice states that end date)"],
  }),
  spec({
    id: "ca-repo-notice",
    family: "consumer",
    title: "California: a notice that your repossessed car will be sold (notice of intent to sell)",
    plain: "The lender's notice, after a car bought on a dealer contract was repossessed, saying it will sell the car and how to get it back.",
    confidence: "HEDGE",
    anchor: "mailed",
    dateLabel: "Date the notice was given to you or mailed",
    dateQuestion: "What day was the notice mailed or handed to you? You can say something like September 13th.",
    count: { days: 15, unit: "calendar", roll: "none" },
    lead: "You can get the car back by paying off the contract, or sometimes by catching up on it, at least until {date}",
    also: [{ label: "If you ask in writing before then, they have to add 10 more days, to {date} for a 15-day notice.", days: 25 }],
    note: "This is for a car bought on a dealer's installment contract. If the notice was mailed from or to outside California, it's 20 days instead of 15, and 30 with the extension. The days count from when the notice was given or mailed, not from the repossession. I don't move the date for a weekend or holiday, so it's the safe date to act by.",
    must: /repo(ssess\w*)?\b|intent to (sell|dispose)|redeem|reinstat\w*/i,
    // A car on a dealer contract only (§ 2983.2): not furniture, a home, a storage unit, a pawn, or a license or benefits.
    // Not after the sale: there's nothing to redeem then, and "you owe the difference" is a deficiency.
    not: /\b(furniture|rent[- ]to[- ]own|appliances?|tv|television|house|home|trustee|storage|pawn|license|licence|medi-cal|benefits|sold|auction(ed)?|deficiency|owe the (difference|rest|balance))\b/i,
    detect: [/repossess\w*|\brepo\b/i, /intent to (sell|dispose)|dispos\w*|\bsale\b/i, /redeem|reinstat\w*|vehicle|car\b|motor vehicle/i],
    spoken: /\brepo(ssess\w*)?\b/i,
    answers: /\b(repo\w*|car|vehicle|truck)\b/i,
    keyterms: ["repossession", "notice of intent to sell", "reinstate"],
    headline: "Call the lender, and ask in writing for the 10-day extension if you need more time",
    steps: [
      "Read the notice: it says what you'd have to pay to get the car back, and whether you can catch up (reinstate) instead of paying it all.",
      "If you need more time, ask in writing for the 10-day extension before this date, using the form that came with the notice.",
      "Even after this date, until the car is sold, ask the lender whether you can still get it back. And ask how to get your personal things out of it.",
    ],
    help: [LAWHELP, TWO11],
    sources: ["Civil Code § 2983.2(a) (at least 15 days' written notice before a repossessed car is sold; the right to redeem, and any right to reinstate, until 15 days from giving or mailing the notice, 20 if mailed from or to outside California; 10 more days on written request)"],
  }),
  // ---- housing: a housing authority ending a voucher or a public housing lease -------------------------------------
  spec({
    id: "hud-voucher-termination",
    family: "housing",
    title: "A housing authority notice ending your Section 8 voucher (housing choice voucher)",
    plain: "A letter from the housing authority saying it will stop your voucher's rent payments, with your right to an informal hearing.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "When a housing authority ends your voucher because of something your family did or didn't do, or because you were away too long, the notice has to say why and give the deadline to ask for an informal hearing.",
    must: /housing authority|\bPHA\b|housing choice voucher|section 8|\bvoucher\b/i,
    not: /\b(landlord|owner)\b/i,
    detect: [/housing authority|\bPHA\b/i, /housing choice voucher|section 8|\bvoucher\b|housing assistance/i, /terminat\w*|informal hearing|end\w*|stop\w*/i],
    spoken: /^(?!.*\b(landlord|owner)\b)(?=.*\b(housing authority|pha|section 8|section eight|voucher)\b)(?=.*\b(terminat\w*|kick\w* (me )?off|losing|lose|taking (away )?my|ending|end|stop\w*|cut\w* off|kick\w* me off)\b)/is,
    answers: /\b(voucher|section 8|section eight|housing authority)\b/i,
    keyterms: ["housing authority", "informal hearing", "housing choice voucher"],
    headline: "Ask the housing authority for an informal hearing by the date on the notice",
    steps: [
      "Ask for the informal hearing right away, in writing if you can, and keep a copy. If the notice gives no deadline, or it looks wrong, get help right away.",
      "For most reasons, the housing authority has to give you the chance for a hearing before it stops paying your rent share.",
      "Keep paying your part of the rent while you wait, and ask legal aid to help you prepare.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["24 CFR 982.555(a)(1)(iv)–(v) and (a)(2) (an informal hearing before the housing authority stops payments for a family's action or absence) and (c)(2) (the notice gives the reasons and the deadline to ask)"],
  }),
  spec({
    id: "hud-public-housing",
    family: "housing",
    title: "Public housing: a notice ending your lease",
    plain: "A housing authority's written notice ending a public housing lease, for example for unpaid rent.",
    confidence: "HEDGE",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    dateQuestion: "What date is printed on the lease termination notice? You can say something like September 13th.",
    count: { days: 30, unit: "calendar", roll: "none" },
    lead: "For unpaid rent, your public housing lease can't end before {date}",
    note: "This counts from the date on the notice, the earliest start. For some other reasons, such as a threat to others' safety or criminal activity, the notice can be shorter.",
    must: /public housing/i,
    detect: [/public housing/i, /housing authority|\bPHA\b/i, /terminat\w*|evict\w*|grievance|vacate|end\w* (your |the )?lease/i],
    spoken: /^(?=.*\bpublic housing\b)(?=.*\b(evict\w*|terminat\w*|kick\w* (me )?out|end\w* (my |the )?lease|lease (is )?end\w*|move out)\b)/is,
    answers: /\bpublic housing\b/i,
    keyterms: ["public housing", "grievance hearing", "lease termination"],
    headline: "Ask about a grievance hearing, and get free legal help",
    steps: [
      "The notice has to say why, and tell you about your right to reply, to see the housing authority's papers about it, and, if it applies, to ask for a grievance hearing. Ask for that in writing right away.",
      "This notice isn't an eviction order. To evict you, the housing authority has to go to court, and you'll get court papers you can answer.",
      "If it's about rent, ask whether a hardship exemption or a rent recalculation applies.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["24 CFR 966.4(l)(3)(i) (a public housing lease termination notice: at least 30 days for unpaid rent; shorter for threats to health or safety, drug-related or violent criminal activity, or a felony) and (l)(3)(ii) (the notice states the grounds and the tenant's rights, including a grievance hearing when it applies)"],
  }),
  // ---- housing: foreclosure (a deed of trust) --------------------------------------------------------------------
  spec({
    id: "ca-foreclosure-nod",
    family: "housing",
    title: "California: a Notice of Default on your home loan (the start of a foreclosure)",
    plain: "A recorded notice that you're behind on a mortgage or deed of trust, the first step before a trustee's sale.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "A Notice of Default starts the foreclosure clock: the home can't be sold until at least 3 months and 20 days after it was recorded, and the recording date is on the notice.",
    must: /notice of default|foreclos\w*|behind on (my |the )?(mortgage|house payments?|home loan)|deed of trust/i,
    // Not a tenant whose landlord is being foreclosed on (a tenant has other rights and dates), and not a car, a
    // storage unit or a property-tax default.
    not: /trustee'?s sale|notice of sale|auction|\b(car|vehicle|truck|storage|property tax(es)?|tax sale|landlord|tenant|I rent|renting|renter)\b/i,
    detect: [/notice of default|election to sell/i, /deed of trust|mortgage|trustee|beneficiary/i, /reinstat\w*|past due|default|foreclos\w*/i],
    spoken: /notice of default|foreclos\w*|behind on (my |the )?(mortgage|house payments?|home loan)/i,
    answers: /\b(default|mortgage|foreclos\w*|home loan)\b/i,
    keyterms: ["Notice of Default", "foreclosure", "deed of trust"],
    headline: "Call a HUD-approved housing counselor or legal aid now, and ask the lender how to catch up",
    steps: [
      "You can catch up on the missed payments and costs (reinstate) until 5 business days before the sale date in the notice of sale.",
      "Watch for a Notice of Trustee's Sale: it sets the sale date, and the time to catch up ends 5 business days before it.",
      "Ask the lender in writing for the amount to catch up, and about other options such as a loan modification.",
      "If your homeowners association is foreclosing without going to court over assessments that came due from 2006 on, you may still be able to redeem the home for 90 days after the sale, and the notice of sale is supposed to mention that right. Ask legal aid right away.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["Civil Code § 2924(a)(2)–(4) (at least three months after the notice of default is filed before a notice of sale; the sale no earlier than three months and 20 days after it's recorded)",
              "Civil Code § 2924c(b)(1) (the notice of default's own statement: no sale date may be set until approximately 90 days after it's recorded)",
              "Civil Code § 2924c(e) (reinstatement from the notice of default until five business days before the sale date in the recorded notice of sale)",
              "Civil Code § 5715(a)–(b) (for assessment debts arising on and after January 1, 2006, an association's nonjudicial foreclosure for delinquent assessments is subject to a right of redemption that ends 90 days after the sale, and its notice of sale must say so)"],
  }),
  spec({
    id: "ca-foreclosure-sale",
    family: "housing",
    title: "California: a Notice of Trustee's Sale (your home is set to be sold)",
    plain: "A notice giving the date, time and place your home will be sold at a foreclosure auction.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "A Notice of Trustee's Sale prints the date the home will be sold. You can usually still catch up on the loan (reinstate) until 5 business days before that date.",
    must: /trustee'?s sale|notice of sale|foreclosure (sale|auction)|auction/i,
    // Not a car, storage, pawn or tax sale; not a tenant (a tenant after a foreclosure sale has other rights and dates);
    // not an IRS or sheriff's sale for a judgment (not a § 2924 trustee's sale). An HOA's sale is answered, with the
    // § 5715 redemption step.
    not: /\b(car|vehicle|truck|storage|pawn|property tax(es)?|tax sale|tax[- ]defaulted|landlord|tenant|I rent|renting|renter|notice to vacate|IRS|internal revenue|sheriff|(for|to collect) a judgment|judgment (lien|creditor)|writ of execution)\b/i,
    detect: [/trustee'?s sale|notice of sale/i, /deed of trust|trustee|beneficiary|mortgage/i, /auction|public sale|sale date|highest bidder/i],
    spoken: /trustee'?s sale|notice of sale|foreclosure (sale|auction)|auction(ing)? (off )?my (house|home|condo)|sell(ing)? my (house|home|condo) at (an )?auction|auction date for my (house|home|condo)/i,
    answers: /\b(sale|auction|trustee)\b/i,
    keyterms: ["Notice of Trustee's Sale", "trustee sale", "reinstate"],
    headline: "Call a housing counselor or legal aid today",
    steps: [
      "Ask the lender in writing, right away, for the amount to catch up (the reinstatement amount).",
      "If the sale is postponed by more than 5 business days, the time to catch up comes back, until 5 business days before the new date.",
      "Don't wait for the last days: ask legal aid now what can still be done.",
      "If your homeowners association is foreclosing without going to court over assessments that came due from 2006 on, you may still be able to redeem the home for 90 days after the sale, and the notice of sale is supposed to mention that right. Ask legal aid right away.",
    ],
    help: [LSNC, LAWHELP, TWO11],
    sources: ["Civil Code § 2924c(e) (reinstatement until five business days before the sale date in the recorded notice of sale; revived when a sale is postponed for more than five business days)",
              "Civil Code § 5715(a)–(b) (for assessment debts arising on and after January 1, 2006, an association's nonjudicial foreclosure for delinquent assessments is subject to a right of redemption that ends 90 days after the sale, and its notice of sale must say so)"],
  }),
  // ---- court: small claims -----------------------------------------------------------------------------------------
  spec({
    id: "ca-small-claims",
    family: "court",
    title: "California: small claims court papers (someone is suing you in small claims)",
    plain: "A Plaintiff's Claim and Order to Go to Small Claims Court, with the hearing date.",
    confidence: "HEDGE",
    anchor: null,
    count: null,
    hedge: "Small claims papers give the hearing date, and that's the date that counts.",
    must: /small claims|SC-100|plaintiff'?s claim and order/i,
    // Being sued, not suing, and not collecting a judgment you won.
    // …and never an eviction (a UD needs a written response within 10 court days, CCP § 1167 as amended by AB 2347; small claims can't hear one), unless
    // it's a landlord suing for back rent or a deposit with no eviction word.
    not: /\b(want(ed)? to sue|I('m| am)? (going to )?sue|I('m| am) suing|I sued|file (a|my) (small claims|claim)|I won(?!['’]t)|collect (my|the|on (a|my|the)) judgment)\b|(\b(might|may|could|will|going to|threaten\w*)\b|['’]ll\b).{0,20}\b(take me to|sue me)\b|\b(unlawful detainer|UD)\b|^(?!.*\b(back rent|security deposit)\b).*\bevict\w*/is,
    detect: [/small claims/i, /plaintiff'?s claim|SC-100|order to go to/i, /hearing|court date|trial date|defendant/i],
    spoken: /small claims|\bSC-?100\b/i,
    answers: /\bsmall claims\b/i,
    keyterms: ["small claims", "Plaintiff's Claim", "SC-100"],
    headline: "Go to the hearing on that date, with your witnesses and documents",
    steps: [
      "Go to the hearing on the date on the papers, and bring your witnesses and any documents that show your side.",
      "If you can't go that day, ask the court in writing to postpone it, at least 10 days before the hearing if you can. Later, you can still ask, but you'll need a good reason. Mail or hand a copy to each of the other parties the same day.",
      "The papers had to be served at least 15 days before the hearing, or 20 if you live in another county. If they came later, tell the court.",
    ],
    help: [SELFHELP, LAWHELP, TWO11],
    sources: ["Code of Civil Procedure § 116.330(a) (the order directs the parties to appear at the hearing with witnesses and documents)",
              "Code of Civil Procedure § 116.570(a) (a written request to postpone for good cause, at least 10 days before the hearing, copied to the other parties)",
              "Code of Civil Procedure § 116.340(b) (service at least 15 days before the hearing, or 20 if the defendant lives outside the county)"],
  }),
  // ---- taxes: the IRS -------------------------------------------------------------------------------------------
  spec({
    id: "irs-deficiency",
    family: "tax",
    title: "IRS: a Notice of Deficiency (the 90-day letter)",
    plain: "An IRS letter saying you owe more tax, and that you can go to the U.S. Tax Court before you pay.",
    anchor: "mailed",
    dateLabel: "Date the notice was mailed (printed on it)",
    count: { days: 90, unit: "calendar", roll: "dc" },
    must: /notice of deficiency|statutory notice|\b(90|ninety)[- ]day letter|tax court/i,
    detect: [/notice of deficiency|statutory notice/i, /\b(IRS|internal revenue)\b/i, /\b(90|ninety) days|\bpetition\b|tax court/i],
    spoken: /^(?=.*\b(irs|tax|taxes)\b)(?=.*\b(notice of deficiency|deficiency|(90|ninety)[- ]day letter|tax court)\b)/is,
    answers: /\b(deficiency|90|ninety|tax court)\b/i,
    keyterms: ["Notice of Deficiency", "Tax Court", "IRS"],
    headline: "File a petition with the U.S. Tax Court",
    steps: [
      "To challenge it without paying first, file a petition with the U.S. Tax Court by this date. The notice also prints the last day to file, and a petition filed by that date counts as on time.",
      "If the notice was addressed to you outside the United States, you have 150 days instead.",
      "Get help first if you can: a Low Income Taxpayer Clinic (free or low cost, if you qualify) or the Taxpayer Advocate Service (free).",
    ],
    help: [LITC, TAS, TWO11],
    sources: ["26 U.S.C. § 6213(a) (90 days after the notice is mailed, 150 if it's addressed outside the United States; a Saturday, Sunday or D.C. legal holiday doesn't count as the last day; a petition by the date on the notice is timely)"],
  }),
  spec({
    id: "irs-levy",
    family: "tax",
    title: "IRS: a final notice of intent to levy (and your right to a hearing)",
    plain: "An IRS notice (such as CP90, LT11 or Letter 1058) saying it plans to take your wages, bank account or other property.",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 30, unit: "calendar", roll: "dc" },
    must: /\blevy\b/i,
    detect: [/intent to levy|notice of levy/i, /\b(IRS|internal revenue)\b/i, /collection due process|right to a hearing|form 12153/i],
    spoken: /^(?=.*\b(irs|tax|taxes)\b)(?=.*\b(levy|levied|intent to levy)\b)/is,
    answers: /\b(levy|final notice|garnish\w*|seize|bank account|wages)\b/i,
    keyterms: ["intent to levy", "Collection Due Process", "Form 12153"],
    note: "Every day counts, but a last day on a weekend or a D.C. holiday moves to the next business day. A state holiday where the IRS office is could add a day more, so this date is the safe side.",
    headline: "Ask for a Collection Due Process hearing",
    steps: [
      "Ask for a Collection Due Process hearing by this date with Form 12153, sent to the address on the notice. While the hearing is pending, the IRS generally can't levy, and you can go to Tax Court if you disagree with the result.",
      "If you miss it, you can still ask for an equivalent hearing within a year of the notice's date, but you can't take that result to Tax Court.",
      "Get help: a Low Income Taxpayer Clinic (free or low cost, if you qualify) or the Taxpayer Advocate Service (free).",
    ],
    help: [LITC, TAS, TWO11],
    sources: ["26 U.S.C. § 6330(a)(3)(B), (b) and (e)(1) (a hearing requested during the 30-day period; levy suspended while it's pending)",
              "Treas. Reg. § 301.6330-1(c)(2) Q&A-C4 (the 30 days begin the day after the date of the notice; §§ 7502 and 7503 apply) and (i)(2) Q&A-I7 (an equivalent hearing within one year)",
              "26 U.S.C. § 7503 (a last day on a Saturday, Sunday or legal holiday moves to the next day)"],
  }),
  spec({
    id: "irs-cp2000",
    family: "tax",
    title: "IRS: a CP2000 notice (proposed changes to your tax return)",
    plain: "An IRS notice saying the income on your return doesn't match what employers or banks reported, and proposing changes.",
    confidence: "HEDGE",
    anchor: "notice",
    dateLabel: "Date printed on the notice",
    count: { days: 30, unit: "calendar", roll: "none" },
    must: /\bcp ?2000\b|proposed changes/i,
    detect: [/\bcp ?2000\b/i, /\b(IRS|internal revenue)\b/i, /proposed (changes|amount)|underreport/i],
    spoken: /\bcp ?2000\b|^(?=.*\birs\b)(?=.*\b(proposed changes?|underreported|doesn't match|didn't report|missing income)\b)/is,
    answers: /\b(cp ?2000|proposed|changes|underreport\w*|income)\b/i,
    keyterms: ["CP2000", "proposed changes"],
    headline: "Reply to the IRS by the response date on the notice",
    steps: [
      "Reply by the response date on the notice, saying whether you agree, with papers that show why if you don't. It's usually 30 days from the date of the notice, or 60 if you live outside the United States.",
      "If you need more time, ask for it on the reply form or by calling the number on the notice.",
      "If the IRS doesn't hear from you by that date, it sends a Notice of Deficiency, and then you have 90 days to go to Tax Court (150 if the notice is addressed to you outside the United States).",
    ],
    help: [LITC, TAS, TWO11],
    sources: ["IRS Tax Topic 652, Notice of underreported income, CP2000 (respond within 30 days of the date of the notice, 60 if outside the U.S.; otherwise a statutory notice of deficiency)",
              "IRS, Understanding your CP2000 notice (reply by the date listed; you can ask for more time)"],
  }),
  spec({
    id: "ca-ftb-npa",
    family: "tax",
    title: "California Franchise Tax Board: a Notice of Proposed Assessment",
    plain: "A letter from California's Franchise Tax Board saying you owe more state income tax, and that you can protest it.",
    anchor: "mailed",
    dateLabel: "Date the notice was mailed (printed on it)",
    count: { days: 60, unit: "calendar", roll: "none" },
    must: /franchise tax board|\bFTB\b/i,
    not: /\b(lev(y|ies|ied|ying)|garnish\w*|final notice|balance due|collection\w*|order to withhold|withholding order|refund\w*)\b/i,
    detect: [/franchise tax board|\bFTB\b/i, /proposed (deficiency )?assessment|\bNPA\b/i, /\bprotest\b|\b(60|sixty) days/i],
    spoken: /^(?!.*\b(lev(y|ies|ied|ying)|garnish\w*|final notice|balance due|collection\w*|refund\w*|bill|wages?|bank)\b)(?=.*\b(franchise tax( board)?|ftb)\b|(?!.*\b(irs|internal revenue)\b).*\b(state tax(es)?|california tax(es)?)\b)(?=.*\b(proposed assessment|assessment|owe|protest|more tax)\b)/is,
    answers: /\b(franchise|ftb|state|california)\b/i,
    keyterms: ["Franchise Tax Board", "Notice of Proposed Assessment", "protest"],
    headline: "File a written protest with the Franchise Tax Board",
    steps: [
      "Protest in writing by this date, and say why you disagree. The notice also prints the last day to protest, and a protest filed by that date counts as on time.",
      "If you don't protest in time, the proposed amount becomes final.",
      "Get help if you can: some Low Income Taxpayer Clinics help with California tax too, free or low cost if you qualify. Ask when you call.",
    ],
    help: [LITC, LAWHELP, TWO11],
    sources: ["Revenue and Taxation Code § 19041(a) (a written protest within 60 days after the notice is mailed) and (b) (a protest by the last date the notice specifies is timely)",
              "Revenue and Taxation Code § 19042 (with no protest, the assessment becomes final when the 60 days end)"],
  }),
];

// The Social Security rules never claim another program's disability letter when Social Security isn't named:
// EDD or state disability (SDI), workers' comp (WCAB), veterans' benefits, or long-term disability through work.
const NOT_SSA = /^(?!.*\b(social security|SSA|SSI|SSDI)\b).*\b(EDD|employment development|state disability|SDI|workers'? ?comp\w*|WCAB|veterans?|long[- ]term disability|disability insurance (through|from) (work|my job|my employer)|private disability|accommodation|workplace|at work|my job|my employer|DMV|driver'?s license|my license)\b/is;
// The VA in capitals, or "the va" as ASR writes it; a bare "Va." (Virginia) or Spanish "va" isn't it.
const NOT_SSA_VA = /^(?![\s\S]*\b([Ss]ocial [Ss]ecurity|SOCIAL SECURITY|SSA|SSI|SSDI)\b)[\s\S]*(\bVA\b|\b[Tt]he [Vv][Aa]\b(?!\.))/;
// A sentence that leads with EDD is EDD's, even when it mentions Social Security later ("EDD denied my disability,
// I'm also on social security").
const EDD_FIRST = /^(?:(?!\b(?:social security|SSA|SSI|SSDI)\b).)*\b(EDD|employment development)\b/is;
const anyOf = (...res) => ({ test: (t) => res.some(re => re?.test(t)) });
// Social Security said only as income ("I'm on SSI", "social security is my income") next to another agency or
// program's decision (the DMV, the housing authority, the county, a landlord…) isn't a Social Security letter.
// Not when Social Security is itself the one deciding, with the agency only the reason ("social security says I was
// overpaid because of my EDD payments"); the window can't cross another agency's name. "They" counts as Social
// Security only when what they cut or stop is Social Security's ("they are cutting it", "…my check"), not "they
// stopped my Medi-Cal".
const SS_AS_INCOME = /^(?!.*\b(social security|SSA|SSI|SSDI)\b(?:(?!\b(DMV|county|landlord|housing authority|EDD|Medi-Cal|CalFresh|IRS|parking|they)\b).){0,20}\b(says?|said|denied|den(y|ies)|(is|are) (cutting|reducing|stopping|taking)|cut\w*|reduc\w*|stop\w*|overpa\w*|sent)\b)(?!.*\bthey\b.{0,12}\b((is|are) (cutting|reducing|stopping|taking)|cut\w*|reduc\w*|stop\w*|den(y|ies|ied))\b (it|my (check|SSI|SSDI|benefits|payments?|social security))\b|.*\bthey\b.{0,12}\bden(y|ies|ied) me (again|twice|a second time)\b)(?=.*\b((I'?m|I am) on|I (get|receive)|I live on|is my income|my income is)\b)(?=.*\b(DMV|DUI|driver'?s license|housing authority|section 8|voucher|county|CalFresh|Medi-Cal|landlord|parking|repair|IRS|EDD)\b)/is;
for (const r of RULES) if (r.family === "ssa") r.not = anyOf(r.not, NOT_SSA, NOT_SSA_VA, EDD_FIRST, SS_AS_INCOME);

// The spoken detector tries rules in this order: most specific first ("a jury summons" before "summons").
export const SPOKEN_ORDER = ["jury-summons", "ca-ud", "ca-small-claims", "ca-civil-summons", "ca-foreclosure-sale", "ca-foreclosure-nod", "ca-3day", "ca-medi-cal-plan", "ca-medi-cal-plan-denial",
  "ca-noa", "ca-edd-sdi", "ssa-overpayment", "ssa-benefits-ending", "ssa-appeals-council", "ssa-recon", "ssa-initial", "ca-edd-determination", "ca-parking-review", "ca-parking-delinquent", "ca-parking-ticket", "ca-dmv-aps", "ca-traffic-ticket",
  "ca-ftb-npa", "irs-deficiency", "irs-levy", "irs-cp2000", "hud-public-housing", "hud-voucher-termination", "ca-sheriff-vacate", "ca-subsidy-end", "ca-water-shutoff", "ca-utility-shutoff", "ca-repo-notice", "debt-validation", "ca-60day-notice", "ca-30day-notice", "ca-rent-increase"];

// Words that could mean more than one kind of letter. The line asks which, then matches the answer among
// the candidates' `answers`.
export const AMBIGUOUS = [
  // A Social Security denial that mentions a hearing, with no decision in it: before the hearing it's a
  // reconsideration's step (ask for a hearing), after it the Appeals Council's. Both give 60 days plus 5; only the
  // step differs, and tense is hard to hear, so the line asks. `preempt`: it can override the rules' pick, but only
  // when that pick is one of its candidates or nothing matched.
  // `unless`: not when the reconsideration rule's own exclusions fire (a judge's decision, a Notice of Decision,
  // another program), not on a Notice of Reconsideration or an initial denial, which say which letter they are.
  { preempt: true,
    // Social Security (or a disability judge that isn't about a job), a hearing, and an outcome or appeal word: a
    // custody, immigration or criminal hearing from a caller on SSI isn't asked. (The outcome-word lookahead is a second
    // guard: ssa-recon's no-cue exclusion, which `unless` reads, already keeps out a cue-less hearing that names another
    // court or program.)
    spoken: /^(?=.*\b(social security|SSA|SSI|SSDI)\b|(?!.*\b(accommodation|at work|my job|employer)\b)(.*\bdisability\b.*\b(judge|ALJ)\b|.*\b(judge|ALJ)\b.*\bdisability\b))(?=.*\bhearings?\b)(?=.*\b(denied|deny|denial|turned (me )?down|said no|rejected|lost|against me|unfavorable|not disabled|again|twice|second time|reconsider\w*|appeal\w*|judge|ALJ)\b)/is,
    unless: (t) => RULES.find(r => r.id === "ssa-recon").not.test(t) || /notice of reconsideration|notice of disapproved claim|\b(initial|first) (determination|denial|decision)\b|(ask|request)( for)? (a )?reconsideration/i.test(t),
    candidates: ["ssa-recon", "ssa-appeals-council"],
    question: "Have you already had your Social Security hearing with a judge?",
    // Tried in order, before each rule's own `answers`: a "not yet" first, so "no, I haven't had it" isn't read as "had it".
    // "Not yet" yields to an outcome or a hearing already had ("no, the judge ruled against me"; "I had it but I haven't
    // heard back"): those are past the hearing.
    answers: [["ssa-recon", /^(?!.*\b(ruled|lost|against me|said no|turned (me )?down|(?<!(haven'?t|have not|hasn'?t|has not|didn'?t|not yet) )(had (it|my hearing|the hearing)|went)|heard back|the decision)\b)(\W*(no|nope|not yet)\b|.*\b(not yet|haven'?t|have not|hasn'?t|has not|scheduled|set for|coming( up)?|waiting|next (week|month))\b)/is],
              ["ssa-appeals-council", /^\W*(yes|yeah|yep|i did)\b|\b(already|had it|had (my|the) hearing|went to (it|the hearing|my hearing)|the judge|lost|ruled|it was|heard back|went|the decision)\b/i]] },
  // "The debt collector says you may have been served already with a lawsuit.": a lawsuit, or still just the letter?
  { spoken: /\b(may|might|could) have (been )?(served|sued)\b/i, candidates: ["ca-civil-summons", "debt-validation"],
    question: "Did you get court papers about a lawsuit, like a summons, or a letter from the debt collector?",
    // Its own answers, in order: court papers first ("I got a summons"), then the letter ("just the letter").
    answers: [["ca-civil-summons", /^(?!.*\bno (court )?papers\b).*\b(court papers|papers|summons|lawsuit|sued|court)\b/i],
      ["debt-validation", /\b(letter|notice|collector|just|only|not yet|no)\b/i]] },
  { spoken: /\bsummons\b|\bcourt papers\b/i, candidates: ["ca-ud", "ca-civil-summons", "jury-summons"],
    question: "Is it about an eviction, a lawsuit about money, or jury duty?" },
  { spoken: /notice to (vacate|move out|terminate)|terminat\w* (of )?(my |the )?tenancy|move[- ]out notice|telling me to move out/i, candidates: ["ca-30day-notice", "ca-60day-notice"],
    question: "Does the notice give you 30 days or 60 days?" },
  { spoken: /\b(irs|internal revenue)\b/i, candidates: ["irs-cp2000", "irs-deficiency", "irs-levy"],
    question: "Is it a CP2000 about proposed changes to your return, a Notice of Deficiency, or a final notice before a levy?" },
];

// Every word the recognizer should expect, from every rule (for speech-to-text key-term prompting).
export const KEYTERMS = [...new Set(RULES.flatMap(r => r.keyterms ?? []))];

// A notice's own hypotheticals and denials aren't a suit: "If you receive a summons, do not ignore it.", "If you do not
// pay, you may be served with a lawsuit.", "We have not filed a lawsuit against you." For the rules that ask "is this a
// suit?", the hedged phrase is blanked: from a hedge word within 20 characters before a suit word ("no" only right
// before it: "no lawsuit has been filed", not "no idea what this summons means"), through at most three more words
// of that phrase ("with a lawsuit", "against you"). The phrase stops at and/but/was/were/has/have/will/shall/yesterday and at a
// new suit noun that no preposition ties to it, so a real suit after the hypothetical stays: "…you may be served with
// a lawsuit you got a summons yesterday…", "…WITH A LAWSUIT A SUMMONS AND COMPLAINT WAS FILED…". Never in a sentence
// in the caller's own words ("I don't know if the summons is real"): notices say "you" and "we", callers say "I".
// ("before" isn't a hedge: "Before you were served with this summons, …" is a real one.)
const SUIT = "summons|complaint|lawsuit|court papers|suit|sued?|suing|served";
const DET = "(?:(?:a|an|the|this|any)\\s+)?";
const PHRASE_WORD = `\\s+(?:(?:with|of|against|to)\\s+${DET}\\w+|(?!(?:and|but|yesterday|was|were|has|have|will|shall)\\b)${DET}(?!(?:${SUIT})\\b)\\w+)`;
// "may have been served" is a past maybe, not a hypothetical: it isn't blanked (the line asks; see AMBIGUOUS).
// Careful: a hedged phrase longer than three words leaves its last words unblanked ("If you do not pay within 30 days
// of this notice we may file a lawsuit against you in the superior court of California" → "…we   court of
// California"), so no rule may route on "court" plus a collector word alone.
const hedgeSuit = (hedges) => new RegExp(`(?:\\b(?:${hedges})\\b(?!\\s+have been\\b)[^.;!?,]{0,20}?|\\bno (?:\\w+ )?)\\b(?:${SUIT})\\b(?:${PHRASE_WORD}){0,3}`, "gi");
const HEDGE_SUIT = hedgeSuit("if|may|might|could|would|not|never|unless");
// In a sentence that opens with "If", its consequence is hypothetical too: "If you are sued you will be served with a
// summons and complaint.", "If you are sued by us in court the summons will tell you how to respond."
const IF_SUIT = hedgeSuit("if|may|might|could|would|not|never|unless|will|shall");
const SUIT_WILL = new RegExp(`\\b(?:${SUIT})\\b(?=\\s+(?:will|shall)\\b)`, "gi");
const FIRST_PERSON = /\b(I|me|my|I'm|I've)\b/i;
export function unhedged(text) {
  return text.replace(/[^.;!?]+/g, (sentence) => FIRST_PERSON.test(sentence) ? sentence
    : /^\s*if\b/i.test(sentence) ? sentence.replace(IF_SUIT, " ").replace(SUIT_WILL, " ") : sentence.replace(HEDGE_SUIT, " "));
}
export const textFor = (r, text) => r.unhedge ? unhedged(text) : text;

export function detect(text) {
  if (!text || text.trim().length < 20) return null;
  let best = null, bestScore = 0;
  for (const r of RULES) {
    const t = textFor(r, text);
    if ((r.must && !r.must.test(t)) || (r.not && r.not.test(t))) continue;
    const score = r.detect.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
    // "reconsideration" appears in both SSA letters: a reconsideration DETERMINATION offers a hearing.
    // Only between the two SSA letters: without "reconsideration", a hearing offer (the DMV's, a county's) isn't SSA's.
    const bonus = r.id === "ssa-recon" && /reconsideration/i.test(text) && /(request (for )?(a )?hearing|administrative law judge)/i.test(text) ? 2 : 0;
    if (score + bonus > bestScore) { best = r; bestScore = score + bonus; }
  }
  return bestScore >= 2 ? best : null;
}
