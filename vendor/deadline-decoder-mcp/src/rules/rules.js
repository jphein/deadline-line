// Vendored from jphein/deadline-decoder-mcp (commit 7c377f8, published under MIT; src/ is unchanged
// through that repo's later AGPL relicense). Licensed MIT by its author, Jeffrey Pine Hein, for this project.
// See vendor/deadline-decoder-mcp/LICENSE. Upstream edits belong upstream; re-vendor rather than patch here.
// rules.js — one entry per kind of letter. Every rule cites its source, and every result
// shows its arithmetic. Scope is deliberate: four letters, done right, California + federal.
import { d, addDays, addCourtDays, addDaysRolling, isFederalWorkday, fmt, iso, CA_VERIFIED_YEARS } from "./dates.js";

const LSNC = { name: "Legal Services of Northern California", how: "free civil legal aid — lsnc.net or call your local office" };
const LAWHELP = { name: "LawHelpCA.org", how: "find free legal aid anywhere in California by county" };
const SELFHELP = { name: "California Courts Self-Help Guide", how: "selfhelp.courts.ca.gov — forms and step-by-step help" };
const TWO11 = { name: "211", how: "dial 2-1-1 from any phone, 24/7, English and Spanish" };

function yearNote(date) {
  return CA_VERIFIED_YEARS.includes(date.getUTCFullYear()) ? "" :
    " Court holidays for this year are computed from the statute, not checked against the court calendar — confirm with the court.";
}

export const RULES = [
  {
    id: "ssa-recon",
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
    title: "Medi-Cal or CalFresh: a Notice of Action",
    plain: "A county notice that your Medi-Cal or CalFresh (food stamps) is being denied, cut, or stopped.",
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
                "You can bring someone to help you, including free legal aid."],
        help: [LSNC, { name: "CDSS State Hearings", how: "(800) 743-8525 (voice and TDD)" }, LAWHELP, TWO11],
        sources: ["Welfare and Institutions Code § 10951 (90 days; good cause up to 180)", "LSNC Guide to CalFresh Benefits — Requesting a fair hearing"],
      };
    },
  },
];

export function detect(text) {
  if (!text || text.trim().length < 20) return null;
  let best = null, bestScore = 0;
  for (const r of RULES) {
    const score = r.detect.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
    // "reconsideration" appears in both SSA letters: a reconsideration DETERMINATION offers a hearing.
    const bonus = r.id === "ssa-recon" && /(request (for )?(a )?hearing|administrative law judge)/i.test(text) ? 2 : 0;
    if (score + bonus > bestScore) { best = r; bestScore = score + bonus; }
  }
  return bestScore >= 2 ? best : null;
}
