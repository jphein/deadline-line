// dialog.js — the conversation, written for the ear and for a phone keypad-less caller.
// Every fact comes from Deadline Decoder MCP tools; this file only decides what to ask next.
import { RULES, AMBIGUOUS } from "../vendor/deadline-decoder-mcp/src/rules/rules.js";
import { UNKNOWN_LETTER } from "../vendor/deadline-decoder-mcp/src/decoder.js";

const YES = /\b(yes|yeah|yep|sure|ok|okay|please|go ahead|that's right|correct|right)\b/i;
const NO = /\b(no|nope|nah|not now|no thanks|that's wrong|wrong)\b/i;
const HOW = /\b(how|explain|counted|count|why)\b/i;
// A request to repeat, said as the whole request (anchored at the start, so "they say I owe again" and "I read it
// again and it says…" are the caller's own words): "say (that) again", "tell me again", "read it again", "go over that
// again" (after "can/could/would/will you" or "please"), "again, please",
// "what did you say", "sorry, what?", or a bare "again", "huh" or "what". "They denied me again" isn't one.
const REPEAT = /\b(repeat|pardon|come again|one more time|what was that|what did you (just )?say)\b|^\W*((can|could|would|will) you |please )?(say|tell me|read( it| that)?|go over( it| that)?)\b( \w+){0,2} again\b|\bagain,? please\b|^\W*(sorry,? )?(again|huh|what)\W*$|^\W*sorry\W*$|^\W*sorry,? what\b/i;
// One list of goodbye and thanks words.
const BYE_WORDS = "bye|goodbye|that's all|that is all|hang up|thank you|thanks";
const BYE = new RegExp(`\\b(${BYE_WORDS})\\b`, "i");
// A no that ends in a yes ("no, okay go ahead", "no wait, yes"): the caller corrected themselves, and the yes wins.
const NO_THEN_YES = /\b(no|nope|nah)\b.*\b(go ahead|go on|yes|yeah|yep|sure)\W*$/i;
// …but not a yes that is itself negated ("no, I'm not saying yes", "no, not yes", "no, don't go ahead").
const NEGATED_YES = /\b(not|never|\w+n't)\s+(\w+\s+){0,2}(go ahead|go on|yes|yeah|yep|sure)\W*$/i;
// Which date the caller gave, checked against the decoder's. Only an explicit date counts as one: a month and a day
// ("September 3", "3rd of September"; "may" only before a day number), a numeric date ("9/3", "2026-09-03") or "the 3rd"; not a
// stray digit ("I got 2 calls") or a month-shaped word ("may be wrong").
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const RELATIVE_DAY = "today|tonight|yesterday|tomorrow|this (?:morning|afternoon|evening|week)|last night|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const ORD = "(?:st|nd|rd|th)?";
const DATE_CANDIDATE = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})${ORD}\\b|\\b(?:the\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH})\\b|\\b(\\d{1,2})/(\\d{1,2})(?:/\\d{2,4})?\\b|\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\b|\\b\\d{4}-(\\d{1,2})-(\\d{1,2})\\b`, "gi");
// A date taken back outright ("not September 3", "September 3? no", "September 3 isn't the date"), or with a "-n't"
// right before it ("it wasn't September 3": with no other date said, that one is read back to check).
const HARD_BEFORE = /\bnot\s+(?:on\s+)?$/i, SOFT_BEFORE = /\b\w+n't\s+(?:on\s+)?$/i;
const HARD_AFTER = /^\s*(?:(?:isn'?t|is not|wasn'?t|was not)\s+(?:the\s+)?(?:date|it|right|correct)\b|(?:is|was)\s+(?:a\s+)?(?:mistake|wrong|incorrect)\b|\?\s*(?:no|nope|nah)\b)/i;
// The turn's date denied as a whole: "that's not it", "not the date", the other letter's date ("no wait, that's the other
// letter"; which letter it belongs to is left for later).
const DENIED_TURN = /\bthat'?s not (?:it|the date|right(?!\s+now))\b|\b(?:it'?s |that'?s |no,? )?not the date\b|\b(?:for|from|on|that'?s|it'?s|that was|it was) the other letter\b|\bwrong letter\b/i;
// A date counts directly only when nothing else is said with it but filler or plain receipt phrasing ("September 3",
// "it was September 3", "I got it on September 3", "the landlord gave it to me on September 3"); anything else said with
// a date (a no, a hedge, a plan, thanks, a goodbye, a second date, chat) sends it to the check. One whitelist, so a new
// way of hedging or denying can't slip through a word list.
const DIRECT_WORDS = new Set(["um", "uh", "so", "well", "actually", "okay", "ok", "oh", "the", "it", "its", "it's", "was", "is", "on", "date",
  "dated", "i", "got", "received", "they", "served", "handed", "delivered", "posted", "mailed", "gave", "me", "to", "landlord", "my",
  "notice", "letter", "papers", "this", "that", "that's", "a", "an", "from", "for", "of", "with", "and", "by", "sent", "we", "our",
  "us", "you", "your", "here", "says", "say", "on", "in", "at", "be", "been", "came", "come", "were", "them", "him", "her",
  "also", "just", "to", "plus", "over", "off", "dropped", "given"]);
// Letter-specific: "printed" / "mailing" only for a letter counted from its printed or mailing date (Social Security,
// Medi-Cal, IRS, the Franchise Tax Board, EDD, a utility, parking); "due" only for the water bill, counted from its due
// date. For a hand-over letter ("The date printed on the notice is September 3", "The notice is due September 3") they
// send the date to the check.
const allowedWord = (letter) => {
  const rule = letter && RULES.find(r => r.id === letter);
  const printed = /printed|mailing/i.test(rule?.dateLabel ?? ""), due = rule?.anchor === "due";
  // A notice that commonly prints its move-out date ("you must move on or before…": the 30-day, 60-day and sheriff's
  // notices): "my notice says September 3" may be that date, which counted as service errs late: the check. ("dated"
  // stays plain for them.)
  return (w) => DIRECT_WORDS.has(w) || (printed && ["printed", "print", "mailing"].includes(w)) || (due && w === "due");
};
// The letters that state a later date of their own (a move-out, shutoff, effective, end or sale date), so "my notice
// says September 3" may be that date, which counted as the clock's start errs late.
const SAYS_STATED_DATE = new Set(["ca-30day-notice", "ca-60day-notice", "ca-sheriff-vacate", "ca-water-shutoff", "ca-utility-shutoff",
  "ca-rent-increase", "ca-subsidy-end", "ca-repo-notice"]);
// A relative day counts directly only bare: "yesterday", "it was yesterday", "I got it yesterday"; "today" (tonight, this
// morning ...) only with nothing but filler ("today", "it was today").
// What a plain yes at the check may carry besides the yes ("yes, thanks", "yes, bye", "yes it was", "yes, September 3"),
// and nothing more: "yes, that's the wrong one", "yes, that is the due date", "yes, I guess", "yes, about then" aren't.
const YES_REST = new Set(["i", "yes", "yeah", "yep", "yup", "sure", "correct", "right", "that's", "that", "is", "okay", "ok", "please", "thanks",
  "thank", "you", "bye", "goodbye", "it", "it's", "was", "indeed", "exactly", "uh", "um", "oh", "well"]);
// …or plain receipt phrasing with a receipt verb in it ("yes, that's when I got it", "yes, that's the day they gave it to
// me"); never "due", "paid" or "printed" ("yes, that's when I paid"), and nothing without a receipt verb ("yes, the date
// on it" says which date, not that the held one is right).
const RECEIPT_VERB = /\b(?:got|received|handed|gave|given|served|delivered|posted|mailed|came|dropped|sent)\b/i;
const yesRemainderOk = (words) => {
  const receipt = words.some(w => RECEIPT_VERB.test(w));
  return words.every(w => YES_REST.has(w) || (receipt && (DIRECT_WORDS.has(w) || w === "when" || w === "day" || w === "then")));
};
// The caller's own sending ("I sent the notice to my landlord on September 3") isn't the day it reached them: the check.
// (Not a receipt said in the passive: "I was handed eviction papers", "we got it sent".)
// (Through "have / 've / had" and up to six more words, adverbs or fillers in any order ("I um actually also just mailed"): "I have sent my landlord notice", "I also just sent
// it", "I've mailed it to the landlord"; not past another subject: "I think they sent it". Not a
// receipt said in the passive: "I have been handed", "I was handed".)
const SELF_SENT_FIRST = /\b(?:i|we)(?:'ve|'d)?\s+(?:(?:have|has|had)\s+)*(?:(?!was\b|were\b|got\b|been\b|am\b|are\b|have\b|has\b|had\b|they\b|he\b|she\b|it\b|you\b|someone\b|somebody\b|who\b|that\b|the\b|a\b|an\b|my\b|his\b|her\b|their\b|our\b)\w+\s+){0,6}(?:sent|mailed|gave|handed|returned|paid|posted|dropped|delivered|faxed|emailed|served|serve)\b/i;
// …nor said the other way round: "My landlord received notice from me on September 3", "the landlord got it from me".
// …and in the passive: "My notice was received by my landlord on September 3".
const SENT_BY_CALLER = /\bfrom (?:me|us)\b|\b(?:delivered|given|handed|sent|mailed)\s+to\s+(?:my|the|our)\s+(?:landlord|manager|property manager|owner|agency|lender|bank|office)\b|\b(?:my|the|our)\s+(?:landlord|manager|property manager|owner|agency|lender|bank|office)\s+(?:received|got|was given|was handed|was sent)\b|\b(?:received|got|signed for|signed|picked up|accepted)\s+by\s+(?:my|the|our)\s+(?:landlord|manager|property manager|owner|agency|lender|bank|office)\b/i;
// …nor a send to someone, whoever sends it and with any adverbs between ("I also just sent my landlord notice", "I then
// mailed it to my landlord", "we finally dropped it at the office"): a send verb (not in the passive: "I was handed")
// with a recipient after it in its clause, a recipient noun or "to <someone>" (in the passive only "to <someone>": "it
// was mailed over to the landlord", not "I was handed it by the manager"), unless that recipient is "me / us"
// ("they also sent it to me", "the landlord then handed it to me", "they just gave me the notice").
const SEND_VERB = /\b(?:sent|mailed|gave|handed|returned|paid|posted|dropped|delivered|faxed|emailed|took|brought|served|serve)\b/gi;   // "served" only matters with a recipient after it: "they served my landlord"
// Arrival verbs, for the recipient test only ("it came to my landlord", "it got to the office"; "it came to me" is a receipt).
const ARRIVE_VERB = /\b(?:came|got|went|reached)\b/gi;
const TO_SOMEONE = /\bto\s+(?:him|her|them|my|the|our|his|their|a|an)\b/i;
const RECIPIENT_NOUN = "(?:landlord|manager|property manager|owner|agency|lender|bank|office|court|lawyer|attorney|clerk|roommate|husband|wife|son|daughter)s?";
const RECIPIENT_RE = new RegExp(`\\b${RECIPIENT_NOUN}\\b`, "i");
const RECIPIENT = { test: (s) => RECIPIENT_RE.test(s) || TO_SOMEONE.test(s) };
// "by me / us", "by my husband" after a send verb is the caller's side sending: "it was mailed by me", "it was dropped
// off by my husband".
const BY_CALLER = /\bby\s+(?:me|us|(?:my|our)\s+(?:husband|wife|partner|lawyer|attorney|roommate|son|daughter|mother|father))\b/i;
const TO_ME = /^\s+(?:(?:it|them|this|that|one|the\s+\w+(?:\s+\w+)?|a\s+\w+|my\s+\w+(?:\s+\w+)?)\s+)?(?:back\s+)?(?:(?:to|over\s+to)\s+)?(?:me|us)\b/i;
// The send tests read the turn with fillers and their commas gone ("By, uh, me." reads "By me") and punctuation as spaces
// ("To, my landlord.", "To. My landlord.", "From, me.").
const noFillers = (t) => t.replace(/,?\s*\b(?:um+|uh+|er+|erm)\b\s*,?/gi, " ");
const sendText = (t) => noFillers(t).replace(/[^\w\s']+/g, " ").replace(/\s+/g, " ");
// A send verb with someone it went to anywhere after it in the turn, not only in its own clause ("yes, they sent it. It
// was to my landlord.", "Okay. To my landlord.", "It was by me."): a recipient noun, "to / for him, them, someone", or "by
// me / us / my husband". "To me / us" anywhere after the verb wins (a receipt: "from my landlord to me", "To my landlord.
// And to me."). An agent ("I was handed it by the landlord") isn't a recipient.
const AGENT = new RegExp(`\\bby\\s+(?:(?:the|a|an|my|our|his|her|their|that|this)\\s+)?${RECIPIENT_NOUN}\\b`, "gi");
// A source, not a recipient: "by the landlord", "from my landlord" (after an arrival verb, and in a yes at the check).
const SOURCE = new RegExp(`\\b(?:by|from)\\s+(?:(?:the|a|an|my|our|his|her|their|that|this)\\s+)?${RECIPIENT_NOUN}\\b`, "gi");
const TO_ANYONE = /\b(?:to|for)\s+(?:him|her|them|someone|somebody|everyone)\b/i;
// …or named before it as a to / for phrase ("yes, to my landlord they sent it", "for my landlord they mailed it"); never a
// bare noun ("the landlord mailed it", "I was handed it by the landlord" stay receipts).
const TO_SOMEONE_BEFORE = new RegExp(`\\b(?:to|for)\\s+(?:(?:my|our|the|his|her|their|a|an|that|this)\\s+)?(?:${RECIPIENT_NOUN}|him|her|them|someone|somebody|everyone)\\b`, "i");
const PRONOUN_OBJECT = /^\s+(?:it\s+)?(?:(?:just|only|also|even|directly|actually|over|right)\s+)?(?:him|her|them)\b/i;   // "they served just him"
// …unless the caller shares it ("him and me", "her and me the notice"), or is the passive subject ("I was handed them").
const PRONOUN_SHARED = /^\s+(?:it\s+)?(?:(?:just|only|also|even|directly|actually|over|right)\s+)?(?:him|her|them)\s+and\s+(?:me|us)\b/i;
const CALLER_PASSIVE = /\b(?:i|we)\s+(?:was|were|am|are|get|got|(?:have|has|had)\s+been|'ve\s+been)\s+(?:\w+\s+)?$/i;
const SENT_TO_SOMEONE = { test: (u) => {
  for (const m of [...u.matchAll(SEND_VERB), ...u.matchAll(ARRIVE_VERB)]) {
    const after = u.slice(m.index + m[0].length), arrived = /^(?:came|got|went|reached)$/i.test(m[0]);
    if (TO_ME.test(after) || /\bto\s+(?:me|us)\b/i.test(after)) continue;
    if (BY_CALLER.test(after) || TO_SOMEONE_BEFORE.test(u.slice(0, m.index))) return true;
    // A pronoun right after a send verb is who it went to: "they handed him the notice", "they served her", "they gave it him".
    if (!arrived && PRONOUN_OBJECT.test(after) && !PRONOUN_SHARED.test(after) && !CALLER_PASSIVE.test(u.slice(0, m.index))) return true;
    // A cleft with the "to" stranded ("it was my landlord they sent it to", "... sent it to on September 3"): the recipient came first.
    if (/\b(?:to|for)\s*(?:$|(?:on|in|at|last|this|yesterday|today)\b)/i.test(after) && (RECIPIENT_RE.test(u.slice(0, m.index)) || /\b(?:him|her|them)\b/i.test(u.slice(0, m.index)))) return true;
    if (RECIPIENT.test(after.replace(arrived ? SOURCE : AGENT, " ")) || TO_ANYONE.test(after)) return true;
  }
  return false;
} };
// At the check, a yes whose remainder names a recipient (a source "by / from <noun>" aside) isn't a plain yes unless the
// notice came to the caller ("to me / us"): "yes, it came to my landlord", "yes, it was served on my landlord".
const NAMES_RECIPIENT = { test: (words) => {
  const u = words.join(" ");
  if (!RECIPIENT_RE.test(u.replace(SOURCE, " "))) return false;
  return !(/\bto\s+(?:me|us)\b/i.test(u) || [...u.matchAll(SEND_VERB)].some(m => TO_ME.test(u.slice(m.index + m[0].length))));
} };
// A passive send with the recipient as its subject: "my landlord was served September 3", "my landlord was mailed it".
const RECIPIENT_PASSIVE = new RegExp(`\\b(?:(?:my|our|the|his|her|their|a|an|that|this)\\s+)?${RECIPIENT_NOUN}\\s+(?:was|were|got|(?:has|have|had)\\s+been)\\s+(?:sent|mailed|handed|given|delivered|posted|served|faxed|emailed|dropped|returned)\\b`, "i");
const SELF_SENT = { test: (t) => { const u = sendText(t); return SELF_SENT_FIRST.test(u) || SENT_BY_CALLER.test(u) || SENT_TO_SOMEONE.test(u) || RECIPIENT_PASSIVE.test(u); } };
const BARE_WORDS = new Set(["um", "uh", "so", "well", "actually", "okay", "ok", "oh", "it", "its", "it's", "was", "is", "on"]);
const TODAYISH = /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i;
/** The words of `t` other than the given spans and relative days (lowercase, punctuation dropped). */
// On the turn that names the letter ("My second Social Security denial is dated September 13", "I got a 3 day notice
// dated September 28, I also got a 60 day notice to move out"), the words naming letters (any rule's detect phrases, and
// the named letters' titles and keyterms) are the letters, not chat, and only the clause with the date, to the end of the
// turn, is read. Every other turn (an answer to a date question) is read whole.
const LETTER_WORDS = (ids) => new Set(ids.map(id => RULES.find(r => r.id === id)).filter(Boolean)
  .flatMap(r => [r.title, r.carryTitle ?? "", ...(r.keyterms ?? [])]).join(" ").toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean));
// Every word of the turn is read: nothing before the date's clause is dropped ("Maybe, I got a 3 day notice on
// September 3" has a hedge in it). A relative day is kept as a word unless it is the date being tested
// ("It was September 3 and yesterday" has a second date in it).
const otherWords = (t, spans = [], naming = null, dropRelative = false, onlyNamed = false) => {
  let rest = t; for (const c of [...spans].sort((a, b) => b.start - a.start)) rest = rest.slice(0, c.start) + " " + rest.slice(c.end);
  // A "?" is never filler ("September 3?"); a stay request isn't chat ("hold on, it was September 25").
  rest = rest.replace(/\?/g, " ? ").replace(STAY_ALL, " ");
  // "have" / "has" / "'ve" are plain only as a receipt in the perfect ("I've got it", "I have received it", "I have been
  // handed it") or in "it has <date> on it" / "I have it dated <date>"; never "it has to be September 3" or "I have to
  // be out by September 3", which name a date to act by.
  rest = rest.replace(/\b(i|we)(?:'ve|\s+have|\s+has)(\s+(?:just|already))?\s+(?=(?:got|gotten|received|been\s+(?:handed|served|given|sent|mailed))\b)/gi, "$1 ")
    .replace(/\bhas(?=\s+on\s+it\b)/gi, " ").replace(/\bhave(?=\s+it\s+dated\b)/gi, " ");
  // At the check with a letter named ("…, I also have a 30 day notice"), "have" is having that letter.
  if (onlyNamed && naming) rest = rest.replace(/\b(?:have|has)\b/gi, " ");
  if (dropRelative) rest = rest.replace(new RegExp(`\\b(?:${RELATIVE_DAY})\\b`, "gi"), " ");
  // (Only the named letters' own phrases with onlyNamed: at the check, "due date" is no letter's name.)
  const named = onlyNamed && naming ? new Set(naming.flatMap(id => CARRIED_ASKS.get(id)?.candidates ?? [id])) : null;
  if (naming) for (const r of RULES) if (!named || named.has(r.id)) for (const re of r.detect ?? []) rest = rest.replace(new RegExp(`[\\w']*(?:${re.source})[\\w']*`, "gi"), " ");
  const own = naming ? LETTER_WORDS(naming) : new Set();
  return rest.toLowerCase().replace(/[^a-z'? ]+/g, " ").split(/\s+/).filter(w => w && !own.has(w));
};
// A relative day said with a no, a "not", or a plan ("I'll look for it today", "I'll call back tomorrow") is never the date.
const RELATIVE = new RegExp(`\\b(?:${RELATIVE_DAY})\\b`, "i");
const NEGATION = /\b(no|nope|nah|not|never)\b|n't\b/i;
const FUTURE = /\b(?:i'?ll|we'?ll|will|going to|gonna|later|call back|get back|look for|find|check|plan|planning|collect|pick(?:ing)? (?:it )?up)\b/i;
// At the check, a yes is a plain one: no negation, no hedge (maybe, perhaps, probably, might, not sure), no trailing "?"
// ("I'm not sure", "that's not right", "right?", "yes, maybe"); "sure, I guess" and "yeah, I think so" are yeses.
const NOT_A_YES = /\b(?:no|nope|nah|not|never)\b|n't\b|\b(?:maybe|perhaps|probably|might|not sure)\b|\?\s*$/i;
/** The explicit dates said in `t`, each with whether it was taken back (hard) or has a "-n't" before it (soft). */
function dateCandidates(t) {
  const out = [];
  for (const m of t.matchAll(DATE_CANDIDATE)) {
    const mon = (x) => MONTHS.indexOf(x.slice(0, 3).toLowerCase()) + 1;
    const c = m[1] ? { month: mon(m[1]), day: +m[2] } : m[4] ? { month: mon(m[4]), day: +m[3] } : m[5] ? { month: +m[5], day: +m[6] }
      : m[8] ? { month: +m[8], day: +m[9] } : { month: null, day: +m[7] };
    c.start = m.index; c.end = m.index + m[0].length;
    const before = t.slice(0, c.start);
    c.hard = HARD_BEFORE.test(before) || HARD_AFTER.test(t.slice(c.end));
    c.soft = !c.hard && SOFT_BEFORE.test(before);
    c.from = c.hard || c.soft ? before.search(c.hard ? HARD_BEFORE : SOFT_BEFORE) : c.start;   // where the denial starts
    if (c.hard && HARD_AFTER.test(t.slice(c.end))) c.end += t.slice(c.end).match(HARD_AFTER)[0].length;
    out.push(c);
  }
  return out;
}
const sameDay = (iso, c) => { const [, m, d] = iso.split("-").map(Number); return d === c.day && (c.month === null || c.month === m); };
/** "September 3" from "2026-09-03". */
const spokenDay = (iso) => { const [, m, d] = iso.split("-").map(Number); return `${MONTH_NAMES[m - 1]} ${d}`; };
// A goodbye said outright, not just thanks: "okay bye" is a goodbye, "no thanks" at an offer is still a no.
const FAREWELL = /\b(bye|goodbye|hang up)\b/i;
// The caller asking the line to stay ("please don't hang up", "no need to say goodbye", "don't go", "hold on", "stay on the
// line", "wait, please", "wait a second"; "wait" only as an instruction, never "I can't wait" or "I'll wait for the
// mail"): it's taken out of the reply before the yes, no and goodbye words are looked for. "Never mind
// hang up" is a goodbye.
const STAY = /\b((i|we)\s+)?(please,?\s+)?((don'?t|do not|never(?!\s+mind)|no need to)\s+((want|need) (you )?to\s+|\w+\s+)?(hang up|say (good)?bye)\b|(don'?t|do not) (go(?!\s+(ahead|on)\b)|leave)\b|(stay on|hold) the line\b|hold on\b(?!\s+to\b)|(?<!(\bcan'?t|\bcannot|\bcouldn'?t|\bwon'?t|\bwill|'ll|\bto|\bnot|\bi|\bwe)\s+)wait\b(?!\s+(for|on|till|until)\b)(\s+a\s+(second|sec|minute|moment|bit)\b)?)(,?\s+please\b)?/i;
const STAY_ALL = new RegExp(STAY.source, "gi");
// An HOA by name: "HOA" (also spelled out as ASR writes it, "H.O.A." or "h o a"), a homeowners', condo, community or
// owners' association. Not any "association" (the bar association, a neighborhood meeting, a credit union's).
// "H.O.A." in any case; the bare "HOA" in capitals or lowercase, never "Hoa" (a given name); ASR's spaced
// "H O A" only in capitals, since "ho a hearing" is ASR too.
const HOA_ANYCASE = /\b(H\.\s?O\.\s?A\b\.?|homeowners'? association|(condo(minium)?|community|owners'?|property owners'?) association)/i;
const HOA_CASED = /\b(HOA|hoa|H O A)\b/;
// ASR sometimes title-cases a spoken "hoa" that opens a sentence ("Hoa sent me the Notice of Default."): only there,
// and only as the one sending the notice itself or foreclosing, so the name still isn't an HOA: "Hoa is my name",
// "Hoa sent me a text about…", "Hoa sent me my bank's notice…", "Hoa filed my papers…".
const HOA_INITIAL_SENT = /(^|[.!?]\s+)Hoa (sent|mailed|gave|filed)( me| us)?( an?| the)? ([Nn]otice|[Ll]etter|[Ll]ien)\b/;
const HOA_INITIAL_FORECLOSING = /(^|[.!?]\s+)Hoa is (foreclosing|selling|auctioning)\b/;
// A lender that sent the notice ("my bank's notice of default", "from my mortgage lender") beats a title-cased "Hoa"
// that sent one (it may be a person passing it on); a lender only mentioned ("My mortgage is fine.") doesn't, and
// nothing beats "Hoa is foreclosing" or a real "HOA".
const LENDER_SENT = /\b((my |the )?(bank|lender|mortgage|servicer|credit union)('s)? (notice|letter)|from (my |the )?(bank|lender|mortgage( company| lender)?|loan servicer|servicer|credit union))\b/i;
const HOA = { test: (t) => HOA_ANYCASE.test(t) || HOA_CASED.test(t) || HOA_INITIAL_FORECLOSING.test(t) || (HOA_INITIAL_SENT.test(t) && !LENDER_SENT.test(t)) };
// The caller naming a lender on the answering turn means the notice is the lender's, not the HOA's.
const LENDER = /\b(mortgage|lender|bank|loan servicer|servicer|credit union)\b/i;
const HOA_LETTERS = new Set(["ca-foreclosure-nod", "ca-foreclosure-sale"]);
const HOA_STEP = /^If your homeowners association is foreclosing\b/;
const ASK_DATE = "What date is on it? You can say something like September 13th.";
// "a Notice of Default" → "the Notice of Default"; "small claims court papers" → "the small claims court papers".
const theLetter = (name) => /^the /i.test(name) ? name : `the ${name.replace(/^an? /i, "")}`;
// Reinstatement ends five business days before a trustee's sale (Civ. Code § 2924c(e)), not on the sale date.
const SALE_CUTOFF = "the cutoff is generally five business days before the sale date, not the sale date itself.";
// Letters whose day that counts is the day they were served, though the rules ask "What date is on it?".
const SERVED = new Set(["ca-3day", "ca-ud"]);
const STOP_OFFER = "If you find the date, call back right away: some of these run out in days. Do you want to stop here?";
// A carried question ("…, I also got a summons": eviction, lawsuit or jury?) is kept as "ask:<its group's label>"; the
// question and its candidates are the rules' own, looked up here, never taken from the state the page sends back.
export const CARRIED_ASKS = new Map(AMBIGUOUS.filter(g => g.label).map(g => [`ask:${g.label}`, g]));

export const GREETING = "Deadline Line. Tell me what kind of letter you got and the date on it. For example: " +
  "a letter from Social Security dated September 13th, or eviction papers handed to me yesterday.";

export class Dialog {
  /** @param {(name: string, args: object) => Promise<any>} callTool  MCP tools/call, returns structuredContent */
  constructor(callTool, { today } = {}) {
    this.call = callTool;
    this.today = today;           // optional fixed date (tests / demos)
    this.letter = null; this.date = null; this.result = null; this.awaiting = null; this.last = GREETING;
    this.candidates = [];         // the kinds a "which one?" question offered, so the answer is matched among them
    this.dateQuestion = null;     // how to ask for this letter's date ("What day were the papers handed to you?")
    this.hoa = false;             // the caller said it's their HOA, on this turn or an earlier one of this letter
    this.hoaSaid = false;         // the HOA step was already spoken for this letter (reset() clears it for the next one)
    this.carry = [];              // a second letter the caller named in the same turn ("…, I also got a 3 day notice"), next
    this.dateNo = false;          // the caller said "no" to the date question once already
  }

  args(extra) { return this.today ? { ...extra, today: this.today } : extra; }
  say(text, done = false) {
    this.last = text;
    if (done) { this.hoa = false; this.hoaSaid = false; }   // a finished conversation's HOA mention isn't the next one's
    return { say: text, done };
  }
  reset() { this.letter = null; this.date = null; this.result = null; this.awaiting = null; this.candidates = []; this.dateQuestion = null; this.hoa = false; this.hoaSaid = false; this.carry = []; this.dateNo = false; }

  /** The conversation so far, as plain JSON, for a host that keeps nothing between turns (the Vercel demo
   *  hands it to the page and gets it back with the next turn). The deadline isn't in it: restore() recomputes it. */
  snapshot() {
    return { letter: this.letter, date: this.date, awaiting: this.awaiting, last: this.last, candidates: this.candidates, dateQuestion: this.dateQuestion, hoa: this.hoa, hoaSaid: this.hoaSaid,
      carry: this.carry, dateNo: this.dateNo };
  }

  /** Pick a conversation back up from snapshot(). Nothing it says is taken from the snapshot: the date question and
   *  the line to repeat are rebuilt here from the letter and where the conversation stands (the page could send any
   *  text back as "last" or "dateQuestion"). */
  static async restore(callTool, snap = {}, opts = {}) {
    const dialog = new Dialog(callTool, opts);
    dialog.letter = snap.letter ?? null; dialog.date = snap.date ?? null;
    dialog.awaiting = snap.awaiting ?? null;
    dialog.candidates = snap.candidates ?? []; dialog.hoa = snap.hoa === true; dialog.hoaSaid = snap.hoaSaid === true;
    dialog.carry = snap.carry ?? []; dialog.dateNo = snap.dateNo === true;
    dialog.dateQuestion = RULES.find(r => r.id === dialog.letter)?.dateQuestion ?? null;
    if (dialog.awaiting === "more" || dialog.awaiting === "text") await dialog.compute();   // "how did you count?" reads the deadline
    dialog.last = await dialog.lastSaid();
    return dialog;
  }

  /** What the line last said, rebuilt from where the conversation stands (for "say that again"). */
  async lastSaid() {
    const { awaiting, letter } = this;
    if (awaiting === "date" && letter && this.date) return this.confirmQuestion();
    if (awaiting === "date" && letter) return `Got it: ${RULES.find(r => r.id === letter).title}. ${this.dateQuestion ?? ASK_DATE}`;
    if (awaiting === "letter") {
      const group = AMBIGUOUS.find(g => g.candidates.length === this.candidates.length && g.candidates.every(c => this.candidates.includes(c)));
      if (this.candidates.length && group) return group.question;
      return this.date ? `Got the date. ${UNKNOWN_LETTER}` : `${UNKNOWN_LETTER} And what date is on it?`;
    }
    if (awaiting === "stop") return STOP_OFFER;
    if (awaiting === "text" && this.result) return `Here's how I counted. ${this.result.how_we_counted_spoken} Would you like me to text you the date?`;
    // Only a letter that can be answered: one with its date, or one that has no date to ask for.
    if ((awaiting === "more" || awaiting === "another") && letter && (this.date || RULES.find(r => r.id === letter)?.anchor === null)) {
      // The answer again, from a copy (answering changes what's carried and said once). It includes the HOA step when the
      // step was said for this letter (hoaSaid, a validated boolean).
      const copy = Object.assign(new Dialog(this.call, { today: this.today }), { letter, date: this.date, carry: [...this.carry], hoa: this.hoaSaid });
      return (await copy.answer()).say ?? GREETING;
    }
    return GREETING;
  }

  async handle(text) {
    this.declinedDated = false; this.held = null;
    const t = (text || "").trim().replace(/[\u2018\u2019]/g, "'");   // ASR's curly apostrophes (U+2018, U+2019) as plain ones
    // "Don't hang up": this turn doesn't end the call (end()). What was open is kept, to be asked again.
    const unsaid = STAY.test(t) ? t.replace(STAY_ALL, " ") : t;   // the reply without "please don't hang up"
    // …and only when no goodbye is left once it's taken out ("don't hang up, bye" is a goodbye).
    this.staying = unsaid !== t && !FAREWELL.test(unsaid);
    this.before = this.staying ? { ...this.snapshot(), result: this.result } : null;
    if (!t) return this.say("Sorry, I didn't hear anything. " + GREETING);
    if (REPEAT.test(t) && !/\bdated\b|\bletter\b/i.test(t)) return this.say(this.last);
    // A yes, no or goodbye that also names a letter ("no, but I also got an eviction summons", "thanks, I also got an
    // unlawful detainer") is about that letter, not an answer to the question: the decoder decides, not a word list.
    // Right after an answer ("explain how I counted?", the text offer), the letter just answered doesn't count: "no, I
    // understand the 3 day notice" is a no. At the other stages it does ("yes, I also got a 3 day notice" at the stop offer).
    const current = this.awaiting === "more" || this.awaiting === "text" ? this.letter : null;
    const named = (YES.test(t) || NO.test(t) || BYE.test(t)) && await this.namesLetter(t, current);
    // A date read back to check ("Just to check: is the date on … September 3?", awaiting the date with the date held):
    // "yes" counts from it, "no" asks the date again, anything else is read as a new answer to the date question.
    // Never counted from without a plain yes: a letter named here ("no, but I also got a summons") clears the held date and
    // is taken as at the date question; with a plain yes ("yes, and I also got a summons") the date counts and the letter
    // is carried.
    if (this.awaiting === "date" && this.date) {
      const u0 = STAY.test(t) ? t.replace(STAY_ALL, " ") : t;
      // "yes, bye" counts too: the caller hears the deadline before going. Not a yes with a new day in it ("yes, actually
      // it was yesterday": read as the new date), nor a negated or hedged one ("I'm not sure", "that's not right",
      // "right?", "yes, maybe": the date is asked again).
      const said = dateCandidates(t);
      // A yes that says the held date again and nothing else ("yes, it was September 3") is a plain yes.
      const restated = said.length > 0 && said.every(c => !c.hard && !c.soft && sameDay(this.date, c))
        && !SELF_SENT.test(t) && yesRemainderOk(otherWords(t, said)) && !NAMES_RECIPIENT.test(otherWords(t, said));
      const newDay = (said.length > 0 && !restated) || RELATIVE.test(t);
      this.held = this.date;   // the date that was held, for a chatty restatement of it (asked once, then the date again)
      // A stay request and nothing else ("please don't hang up"): the check again, the date still held.
      if (!named && STAY.test(t) && !/\w/.test(u0)) return this.say(`Okay. ${await this.confirmQuestion()}`);
      // A plain yes: nothing but yes words, thanks or a goodbye besides ("yes, that is the due date", "yes, the date on it"
      // aren't: the date is asked again).
      if (YES.test(u0) && !NOT_A_YES.test(u0) && !newDay) {
        // A letter named with the yes: its words are the letter's; the rest must still be a plain yes.
        const ids = named ? await this.namedIds(t) : [];
        // (Never the caller's own sending: "Yes, I mailed it to my landlord" isn't a plain yes.)
        const rest = otherWords(t, said, ids.length ? ids : null, false, true);
        if (!SELF_SENT.test(t) && yesRemainderOk(rest) && !NAMES_RECIPIENT.test(rest)) { if (named) this.addCarry(ids); return this.answer(t); }
        // Not a plain yes, with a letter named ("Yes, that is the due date. I also got a 30 day notice."): the date is
        // asked again and the letter carried.
        if (named) { this.date = null; this.addCarry(ids); this.dateNo = true; return this.say(`Okay. ${this.dateQuestion ?? ASK_DATE}`); }
      }
      this.date = null;
      // A no, a negation or a hedge with no new day in it: the date again (a goodbye said outright still ends the call).
      if (!named && NOT_A_YES.test(u0) && !newDay && !FAREWELL.test(u0)) { this.dateNo = true; return this.say(`Okay. ${this.dateQuestion ?? ASK_DATE}`); }
    }
    // "No" to the date question twice: go on to a letter the caller also named, or offer to stop, not the same ask again.
    const saidNo = this.dateNo; this.dateNo = false;
    // (A no with a date given in it, "no, it was September 25", is a date, not a second no; "no, not the 3rd" is a no.)
    if (this.awaiting === "date" && NO.test(t) && !named && !dateCandidates(t).some(c => !c.hard)) {
      if (saidNo && this.carry.length) return this.startCarry("Okay. ");
      if (saidNo) { this.awaiting = "stop"; return this.say(STOP_OFFER); }
      this.dateNo = true;
    }
    // "Do you want to stop here?": a letter named in the reply ("yes, I also got a 3 day notice") is taken up, not a goodbye.
    // (A forged "stop" stage plus "yes" says goodbye without the offer having been made: self-only, like any stage the page
    // sends back; the state isn't authenticated.)
    const stay = this.staying, u = unsaid;
    const bye = BYE.test(u), farewell = FAREWELL.test(u);
    // A yes with no goodbye in it ("yes thanks", "yes, please don't hang up"); one with a goodbye ("yes, bye", "okay bye")
    // is carried out, then the call ends.
    const yes = YES.test(u) && !farewell;
    // At the offers (go on to it, explain, text) a no wins over a yes-word said with it ("okay, no thanks"), unless the
    // reply ends in a yes ("no, okay go ahead").
    const no = NO.test(u) && !(NO_THEN_YES.test(u) && !NEGATED_YES.test(u));
    this.saidNo = no;   // a stay said with a no ("no, don't hang up"): the question is answered, not asked again
    // A no to stopping, with thanks or not ("no thanks", "no, that's all"), or a "don't hang up" asks the date again: the
    // caller can still say bye, while a call ended on a misread "no" loses the deadline. A goodbye said outright ("no thank
    // you, goodbye") ends it.
    // A date said at the stop offer ("actually it's September 3, thanks") is read, before any yes, no or goodbye.
    const stopDate = this.awaiting === "stop" && !named && this.letter && ["date", "confirm", "reask", "unread"].includes(await this.saysDate(t));
    if (this.awaiting === "stop" && !named && !stopDate) {
      if ((NO.test(u) && !farewell) || stay) { this.awaiting = "date"; return this.say(`Okay. ${this.dateQuestion ?? ASK_DATE}`); }
      if (YES.test(u) || bye) return this.goodbye();
    }
    // A stay request and nothing else ("please don't hang up", "hold on"): the open question again, nothing changed.
    if (stay && !named && !/\w/.test(u)) { const ask = await this.openQuestion(); if (ask) return this.say(`Okay. ${ask}`); }

    // After an answer, an explicit date is a correction ("September 3, thanks", "actually it was September 3"): it is read
    // like an answer to the date question, not as a yes, no or goodbye to the offer.
    const correction = (this.awaiting === "more" || this.awaiting === "text") && !named
      && (dateCandidates(t).some(c => !c.hard || !NO.test(t)) || (RELATIVE.test(t) && ["date", "confirm"].includes(await this.saysDate(t))));
    // (A date only taken back with a no, "no, not September 3", is the offer's own no; "September 3 is not correct" is a
    // correction, not a yes to the offer.)
    // After an answer, a goodbye names a letter the caller also mentioned (leave()), so it isn't dropped unsaid.
    if (this.awaiting === "more" && !named && !correction) {
      const how = `Here's how I counted. ${this.result.how_we_counted_spoken} `;
      // A no first ("okay, no thank you, goodbye"), unless the caller asks how. Said with a goodbye it ends the call; it
      // doesn't start the letter carried.
      if (no && !HOW.test(u)) return !farewell && this.carry.length ? this.startCarry("Okay. ") : this.leave();
      // A yes said with a goodbye ("yes, bye", "explain it, then hang up"): the explanation, then the goodbye.
      if ((HOW.test(u) || YES.test(u)) && farewell) return this.leave(how);
      if (HOW.test(u) || yes) { this.awaiting = "text"; return this.say(`${how}Would you like me to text you the date?`); }
      if (NO.test(u) || bye) return this.leave();
    }
    if (this.awaiting === "text" && !named && !correction) {
      const texted = "Okay. In the real service I'd text the date and a calendar reminder to this number. ";
      // A no first; a letter the caller also named comes next, rather than the goodbye, but not after a goodbye said with
      // the yes or no.
      if (no) return !farewell && this.carry.length ? this.startCarry("Okay. ") : this.leave();
      if (this.carry.length && yes) return this.startCarry(texted);
      // A yes said with a goodbye ("yes, bye", "okay bye"): the text, then the goodbye.
      if (YES.test(u)) return this.leave(texted);
      if (NO.test(u) || bye) return this.leave();
    }
    // "It's from my HOA", said after a notice of default or a trustee's sale was answered: the redemption right, once.
    if ((this.awaiting === "another" || this.awaiting === "more") && HOA_LETTERS.has(this.letter) && HOA.test(t) && !(await this.namesLetter(t, this.letter))) {
      const r = this.result ?? await this.compute();
      const step = r.next_steps.find(s => HOA_STEP.test(s));
      const ask = this.awaiting === "more" ? "Want me to explain how I counted?" : "Do you have another letter I can help with?";
      // Said once per letter: a repeated "it's from my HOA" hears that the step was covered, not the step again.
      if (step && this.hoaSaid) return this.say(`Yes, I've included the homeowners association step for this notice. ${ask}`);
      if (step) { this.hoaSaid = true; return this.say(`${step} ${ask}`); }
    }
    let switched = null;
    if (this.awaiting === "another") {         // after an answer with nothing to count: another letter?
      const carry = this.carry;
      // With a letter carried, a no with thanks ("no thanks", "no thank you, that's all") is a no, answered below like "no":
      // to "Want me to go on to it?" its goodbye names the letter (and, for a trustee's sale, the reinstatement cutoff); so
      // is one said with a goodbye ("no thank you, goodbye": a decline, and the cutoff still matters). A yes with thanks
      // ("yes, thank you") is a yes: it takes the letter up. "Thanks", "bye" or "okay bye" alone is the plain goodbye.
      // With a letter carried, the goodbye names it (leave()), as after an answer: "bye" at "Want me to go on to it?" for a
      // trustee's sale still hears the cutoff.
      // "What date is on it?" for a carried letter that has one: a goodbye or a no is answered after the decoder has looked
      // for a date ("September 3, thanks" is its date; "no thanks" declines it, with the goodbye that names it).
      const dated = carry.length > 0 && !named && !CARRIED_ASKS.has(carry[0]) && (await this.letterInfo(carry[0])).needs_date !== false;
      if (bye && !named && !dated && !((NO.test(u) || (yes && carry.length)) && !CARRIED_ASKS.has(carry[0]))) return carry.length ? this.leave() : this.goodbye();
      // A carried question first (not reached in real flows: answer() opens it itself; kept for a state the page sends).
      if (CARRIED_ASKS.has(carry[0])) return this.startCarry("");
      // "Want me to go on to it?" (a carried letter with no date to ask for): yes takes it up, no ends the call.
      if (carry.length && (await this.letterInfo(carry[0])).needs_date === false && !named) {
        // A no wins over a yes-word said with it ("yeah no thanks", "okay, no thanks"): a decline, whose goodbye names the
        // letter, so nothing is lost unsaid. A no that ends in a yes ("no, okay go ahead") takes it up.
        if (no) return this.leave("Okay. ", true);
        if (YES.test(u)) return this.startCarry("");
      }
      // A no without thanks or a goodbye ("no", "nope", "no, not the 3rd") isn't a decline: as at the date question, the
      // letter is taken up and its date asked, and a second no offers to stop.
      const declinedDated = dated && bye && !yes;
      if (!carry.length && NO.test(u) && !named) return this.goodbye();
      this.reset();
      // The letter the caller also named: this turn is about it (its date, or just "okay"). A different letter named here
      // ("before you say goodbye, I also got a summons") comes first, and the carried one is kept for after it.
      if (carry.length && !named) { [switched, ...this.carry] = carry; this.letter = switched; this.declinedDated = declinedDated; }
      else if (carry.length) this.carry = carry;
      else if (YES.test(u) && !named) return this.say("Okay. Tell me what kind of letter it is, and the date on it.");
    }
    const answered = this.awaiting === "more" || this.awaiting === "text";

    // A date answer has no letter in its words: say which letter we're on, so its date is read the right way
    // ("the due date was August 1st" looks back for a shutoff notice).
    let det;
    try { det = await this.call("detect_letter", this.args(this.candidates.length ? { text: t, among: this.candidates }
      : this.letter ? { text: t, letter_type: this.letter } : { text: t })); } catch (e) { if (bye && !named) return this.goodbye(); throw e; }
    // A failed detection: a goodbye is still a goodbye (the rest is as before).
    if (!det && bye && !named) return this.goodbye();
    // A goodbye comes after the date is looked for: "September 3, thanks, please don't hang up" has a date in it.
    const dt = await this.dateTurn(t, det), dateSaid = dt.kind === "date";
    // A goodbye: no date in the turn, a relative day ruled out ("thanks, I'll look for it today"), or a date taken back
    // with a goodbye said outright ("goodbye, September 3 isn't the date"; with only thanks, the date is asked again).
    // It names a letter carried.
    if (bye && !named && !switched && (dt.kind === "none" || dt.kind === "never" || (dt.kind === "reask" && farewell))) return this.carry.length ? this.leave() : this.goodbye();   // "bye, actually I have a jury summons" isn't a goodbye
    // A bare yes or no to a which-kind question the decoder can't settle ("Is it about an eviction, a lawsuit about money,
    // or jury duty?" → "yes"): that question again, not the generic "I couldn't tell".
    const open = AMBIGUOUS.find(g => this.candidates.length && g.candidates.length === this.candidates.length && g.candidates.every(c => this.candidates.includes(c)));
    if (open && !det.recognized && !det.candidates?.length && (YES.test(t) || NO.test(t)) && !named) { this.awaiting = "letter"; return this.say(open.question); }
    this.candidates = det.candidates ?? [];   // a "which one?" question stays open for the next turn only
    // After an answer, a "which one?" is about a new letter ("the summons"): not the one just answered.
    if (answered && this.candidates.length) { this.letter = null; this.date = null; }
    // A second letter named in the same turn is carried, to be taken up after this one.
    const also = [...(det.also_detected ?? []), ...(det.also_asks ?? []).map(a => `ask:${a.label}`)].filter(c => !c.startsWith("ask:") || CARRIED_ASKS.has(c));
    if (also.length) this.carry = also;
    // A new letter named instead of the carried one ("I also got a 3 day notice" at "Want me to go on to it?"): it comes
    // first, and the carried one is kept for after it.
    if (switched && (det.candidates?.length || (det.recognized && det.letter_type !== switched))) this.carry = [switched, ...this.carry.filter(c => c !== switched)];
    if (this.carry.length && det.recognized) this.carry = this.carry.filter(id => id !== det.letter_type);
    if (det.recognized && det.letter_type !== this.letter) { this.letter = det.letter_type; this.date = null; this.dateQuestion = det.date_question ?? null; }
    if (dateSaid) this.date = dt.date;

    if (HOA.test(t)) this.hoa = true;   // "my HOA sent me a letter" → "what kind?" → "a notice of default"
    // A different sender named ("…actually it's from my mortgage lender") clears an earlier HOA mention; a corrected
    // letter from the same sender ("my HOA gave me a 3 day notice" → "actually it's a notice of default") doesn't.
    else if (LENDER.test(t)) this.hoa = false;
    // A date with a negation, a hedge, a thanks or goodbye word, or a self-correction is read back before it is counted.
    // (Not for a letter that has no date to count from, a trustee's sale say: that one is answered as it is.)
    // Said back again with chat at the check ("I believe September 3" to "…September 3?"): the check once more (marked
    // by the date question's "no" flag, kept in the state), then the date question.
    if (dt.kind === "confirm" && this.held && dt.date === this.held && this.letter) {
      if (saidNo) { this.awaiting = "date"; this.date = null; return this.say(`Okay. ${this.dateQuestion ?? ASK_DATE}`); }
      const again = await this.confirm(dt.date); this.dateNo = true; return again;
    }
    if (dt.kind === "confirm" && this.letter && (!det.recognized || det.letter_type === this.letter)
      && RULES.find(r => r.id === this.letter)?.anchor !== null) return this.confirm(dt.date);
    // A corrected date the decoder can't read, after an answer: the date is asked, not the old deadline said again.
    if (correction && dt.kind === "unread") { this.date = null; this.awaiting = "date"; return this.say(`I still need the date on the letter. ${this.dateQuestion ?? ASK_DATE}`); }
    if (switched && !det.recognized) {
      const info = await this.letterInfo(switched);
      // A decline (thanks or a goodbye, and no date the caller gave), or a plan to look ("okay thanks, I'll check this
      // afternoon"): the goodbye that names it. A date said that couldn't be read is asked again instead.
      if (!this.date && dt.kind !== "unread" && (this.declinedDated || (dt.kind === "never" && bye))) { this.carry = [switched, ...this.carry]; this.letter = null; return this.leave(); }
      if (!this.date && info.needs_date === false) return this.answer(t);
      if (!this.date) { this.awaiting = "date"; if (NO.test(u)) this.dateNo = true; return this.say(`Okay, about ${info.short}. ${ASK_DATE}`); }
    }
    if (this.letter && (this.date || (det.recognized && det.needs_date === false))) return this.answer(t);
    if (this.candidates.length) { this.awaiting = "letter"; return this.say(det.speech); }
    if (this.letter) {
      this.awaiting = "date";
      const ask = this.dateQuestion ?? ASK_DATE;
      // Name the letter only when this turn is what identified it; otherwise just ask for the date again.
      return this.say(det.recognized && det.letter_title ? `Got it: ${det.letter_title}. ${ask}` : `I still need the date on the letter. ${ask}`);
    }
    this.awaiting = "letter";
    // The rules engine's own "which kind?" question, so it names every kind of letter it knows.
    return this.say(this.date ? `Got the date. ${det.speech}` : `${det.speech} And what date is on it?`);
  }

  async compute() {
    const r = await this.call("compute_deadline", this.args(this.date ? { letter_type: this.letter, notice_date: this.date } : { letter_type: this.letter }));
    // compute_deadline's speech is complete but long; on the phone, lead with the date and offer the rest.
    const counted = r.speech.match(/Here's how I counted\. (.*?) First step:/s)?.[1] ?? r.how_we_counted.join(" ");
    return (this.result = { ...r, how_we_counted_spoken: counted });
  }

  async answer(said = "") {
    const r = await this.compute();
    const counted = r.how_we_counted.length > 0;
    this.awaiting = counted ? "more" : "another";
    // A dated SOLID answer says the date; a HEDGE one says what it usually is and points to the notice; a letter
    // that prints its own date (a jury summons) just says so. The rules engine words the last two.
    const head = r.deadline === null || r.confidence === "HEDGE" ? r.lead_spoken
      : r.passed
        ? `That deadline was ${r.deadline_spoken}. It may not be too late: ask for more time in writing, and call free legal aid today.`
        : `Your deadline is ${r.deadline_spoken}. That's ${r.days_left === 1 ? "tomorrow" : r.days_left === 0 ? "today" : r.days_left + " days from today"}.`;
    // What's said about a carried letter is built here, from its id: never a sentence the page sent back.
    const carried = this.carry.length ? `${await this.carryLine()} ` : "";
    const firstAsk = CARRIED_ASKS.get(this.carry[0]);
    const undated = this.carry.length && !firstAsk && (await this.letterInfo(this.carry[0])).needs_date === false;
    const next = carried + (counted ? "Want me to explain how I counted?" : !this.carry.length ? "Do you have another letter I can help with?"
      : firstAsk ? firstAsk.question : undated ? "Want me to go on to it?" : "What date is on it?");
    // Nothing to count and a question carried: that question is open now.
    if (!counted && firstAsk) { this.carry = this.carry.slice(1); this.candidates = firstAsk.candidates; this.awaiting = "letter"; this.letter = null; this.date = null; }
    // A second date or condition some letters carry (keep benefits while you wait; the 90-day rent date) comes next.
    const also = r.also_spoken ? ` ${r.also_spoken}` : "";
    // A caller who said it's their HOA foreclosing also hears the redemption right (the engine's own step, not a copy).
    // The HOA mention may come on an earlier turn than the answer, so it's carried in the state (cleanState keeps it).
    const hoa = HOA_LETTERS.has(r.letter_type) && (this.hoa || HOA.test(said)) ? r.next_steps.find(s => HOA_STEP.test(s)) : null;
    this.hoa = false;                   // said once, for this letter
    if (hoa) this.hoaSaid = true;
    return this.say(`${head} ${r.what_to_do}.${also} First step: ${r.next_steps[0]}${hoa ? ` ${hoa}` : ""} ${r.help_spoken ?? `For free help: ${r.free_help[0].name}, ${r.free_help[0].how}.`} ${next}`);
  }

  /** Take up the letter the caller also named: ask its date (or answer it, when it has none). */
  async startCarry(prefix) {
    const [id, ...rest] = this.carry;
    this.reset(); this.carry = rest;
    const ask = CARRIED_ASKS.get(id);
    if (ask) { this.candidates = ask.candidates; this.awaiting = "letter"; return this.say(`${prefix}${ask.question}`); }
    this.letter = id;
    const info = await this.letterInfo(id);
    if (info.needs_date === false) { const a = await this.answer(); return this.say(prefix + a.say); }
    this.awaiting = "date";
    return this.say(`${prefix}Now, about ${info.short}. ${ASK_DATE}`);
  }

  /** Does this turn give a date for the current letter (as the decoder reads it)? A failed detection gives none. */
  async saysDate(t) {
    try { return (await this.dateTurn(t, await this.call("detect_letter", this.args({ text: t, letter_type: this.letter })))).kind; } catch { return "none"; }
  }

  /** The letters a turn names (a letter, a which-kind question, or one also mentioned), added to the carry. */
  async carryNamed(t) { this.addCarry(await this.namedIds(t)); }
  addCarry(ids) { this.carry = [...new Set([...this.carry, ...ids.filter(c => !c.startsWith("ask:") || CARRIED_ASKS.has(c))])].filter(c => c !== this.letter).slice(0, 3); }
  async namedIds(t) {
    let det; try { det = await this.call("detect_letter", this.args({ text: t })); } catch { return []; }
    if (!det) return [];
    const ids = [...(det.also_detected ?? []), ...(det.also_asks ?? []).map(a => `ask:${a.label}`)];
    if (det.recognized && det.letter_type !== this.letter) ids.unshift(det.letter_type);
    const group = det.candidates?.length && AMBIGUOUS.find(g => g.label && g.candidates.length === det.candidates.length && g.candidates.every(c => det.candidates.includes(c)));
    if (group) ids.unshift(`ask:${group.label}`);
    return ids;
  }


  /** Read a date back before counting from it, holding it (awaiting the date, with the date set). */
  async confirm(iso) {
    // The check starts the "no" count afresh: a "no, it was September 25" to it is a correction, not a second no.
    this.date = iso; this.awaiting = "date"; this.candidates = []; this.dateNo = false;
    return this.say(await this.confirmQuestion());
  }
  /** The check, from the letter's own date question, so it asks for the day that counts ("was the 30-day notice
   *  handed to you on September 3?", "were the papers handed to you on …", "is the date on the ticket …"). */
  async confirmQuestion() {
    const name = theLetter((await this.letterInfo(this.letter)).short), day = spokenDay(this.date);
    const q = (RULES.find(r => r.id === this.letter)?.dateQuestion ?? "").replace(/\s*You can say.*$/, "").replace(/\s*It's often.*$/, "");
    const subject = (x) => x === "the notice" ? name : x;
    let m, ask;
    if ((m = q.match(/^What day (was|were) (the [\w' ]+?) (handed to you.*|mailed.*)\?$/))) ask = `${m[1]} ${subject(m[2])} ${m[3]} on ${day}?`;
    else if ((m = q.match(/^What day did you get (the [\w' ]+?)\?$/))) ask = `did you get ${subject(m[1])} on ${day}?`;
    else if ((m = q.match(/^What date is (printed )?on (the [\w' ]+?)\?$/))) ask = `is the date ${m[1] ?? ""}on ${subject(m[2])} ${day}?`;
    else if ((m = q.match(/^What's the mailing date on (the [\w' ]+?)\?$/))) ask = `is the mailing date on ${subject(m[1])} ${day}?`;
    else if ((m = q.match(/^When was (the [\w' ]+?) due\?$/))) ask = `was ${m[1]} due on ${day}?`;
    else ask = SERVED.has(this.letter) ? `${/papers$/.test(name) ? "were" : "was"} ${name} handed to you on ${day}?` : `is the date on ${name} ${day}?`;
    return `Just to check: ${ask} Say yes, or give me the date.`;
  }

  /** What this turn says about the date, checked against the decoder's: { kind, date }. kind is "date" (count from it),
   *  "confirm" (read it back first), "reask" (a date said and taken back), "never" (a relative day ruled out) or "none". */
  async dateTurn(t, det) {
    const iso = det?.suggested_notice_date ?? null;
    // A turn that names a letter (not the one being asked about): the letters it names, read as the letters.
    const describes = (id) => (RULES.find(r => r.id === id)?.detect ?? []).some(re => re.test(t));
    const naming = det?.letter_type && (det.letter_type !== this.letter || describes(det.letter_type)) ? [det.letter_type, ...(det.also_detected ?? [])] : null;
    const cands = dateCandidates(t);
    if (DENIED_TURN.test(t) && (iso || cands.length)) return { kind: "reask" };
    if (cands.length) {
      if (!iso) return { kind: "unread" };   // a date the decoder can't read ("February 30", "the 3rd")
      const pos = cands.filter(c => !c.hard && !c.soft), neg = cands.filter(c => c.hard || c.soft);
      if (!pos.length) return neg.every(c => c.hard) ? { kind: "reask" } : { kind: "confirm", date: iso };   // "it wasn't September 3": check
      // The date the caller gave: the decoder's if it's one of the kept ones, or the turn read again without the rest
      // ("no, it was not the 3rd, it was September 5" → September 5).
      let date = pos.some(c => sameDay(iso, c)) ? iso : null;
      if (!date) {
        let rest = t; for (const c of [...neg].reverse()) rest = rest.slice(0, c.from) + " " + rest.slice(c.end);
        rest = rest.replace(new RegExp(RELATIVE.source, "gi"), " ").replace(/\bnot\b/gi, " ");
        try { const again = (await this.call("detect_letter", this.args({ text: rest, letter_type: this.letter })))?.suggested_notice_date; date = again && pos.some(c => sameDay(again, c)) ? again : null; } catch { date = null; }
      }
      if (!date) return { kind: "unread" };
      // Direct only with one date and nothing but filler or receipt phrasing besides; else the check.
      // "my notice says September 3" for a letter that states a later date of its own: the check ("says" and up to five
      // words in the same clause before the date: "says by", "says to be out by"; "my landlord says my rent is going up,
      // the notice was handed to me on September 15th" is plain).
      // A deadline preposition right before the date ("by September 3", "no later than September 3", "on or before the
      // 3rd") names a date to act by, for every letter: the check. (For the water bill, "says it's due <date>" is its due
      // date, the clock's start.)
      const L = det?.letter_type ?? this.letter, before = t.slice(0, cands[0].start);
      // (Read with punctuation as spaces: "my notice says: September 3", "says by, September 3", "given. September 3".)
      const beforeWords = before.replace(/[^\w\s']+/g, " ");
      const dueDate = RULES.find(r => r.id === L)?.anchor === "due" && /\bdue\s+(?:on\s+)?$/i.test(beforeWords);
      const statedDate = (SAYS_STATED_DATE.has(L) && !dueDate && /\b(?:says|say|said|reads|shows|states)(?:\s+(?!and\b|but\b|because\b|so\b)[\w']+){0,5}\s+$/i.test(beforeWords)
          && !/\b(?:says|say|said|reads|shows|states)\b(?:\s+[\w']+)*?\s+(?:received|got|handed|served|given|delivered)\b(?:\s+[\w']+){0,4}\s+$/i.test(beforeWords))   // "says I received this on <date>": a receipt
        || /\b(?:by|before|until|till|til|no later than|not later than|on or before)\s+(?:the\s+)?$/i.test(beforeWords)
        // "says I was given <date>" with no object, for every letter: it may be "given until" a date to pay or move by.
        || /\b(?:says|say|said|reads|shows|states)\b(?:\s+[\w']+){0,4}?\s+given\b(?!\s+(?:it|this|that|them|(?:(?:the|a|my|this)\s+)?(?:notice|letter|papers|copy)|to\s+(?:me|us))\b)(?:\s+[\w']+){0,4}\s+$/i.test(beforeWords);
      const direct = cands.length === 1 && !statedDate && otherWords(t, cands, naming).every(allowedWord(det?.letter_type ?? this.letter));
      return { kind: direct && !SELF_SENT.test(t) ? "date" : "confirm", date };
    }
    if (RELATIVE.test(t) && (NEGATION.test(t) || FUTURE.test(t))) return { kind: "never" };
    if (!iso) return { kind: "none" };
    const ok = allowedWord(det?.letter_type ?? this.letter);
    if (!RELATIVE.test(t)) return { kind: otherWords(t, [], naming).every(ok) && !SELF_SENT.test(t) ? "date" : "confirm", date: iso };   // a date read only by the decoder
    // One relative day, and nothing else but filler or receipt phrasing.
    const days = t.match(new RegExp(`\\b(?:${RELATIVE_DAY})\\b`, "gi")) ?? [];
    const words = otherWords(t, [], naming, true);
    const bare = days.length === 1 && (TODAYISH.test(t) ? words.every(w => BARE_WORDS.has(w)) : words.every(ok));
    return { kind: bare && !SELF_SENT.test(t) ? "date" : "confirm", date: iso };
  }

  async letterInfo(id) {
    const all = (this.types ??= (await this.call("list_letter_types", {})).letter_types);
    const t = all.find(x => x.id === id) ?? { title: "other letter", needs_date: true };
    return { ...t, short: t.carry_title ?? t.title.replace(/^California: /, "") };   // the engine's short spoken name
  }

  /** "You also mentioned …; tell me about that next.", from the carried ids and the engine's titles. */
  async carryLine() {
    const names = [];
    for (const id of this.carry) names.push(CARRIED_ASKS.get(id)?.label ?? (await this.letterInfo(id)).short);
    return `You also mentioned ${names.join(" and ")}; tell me about that next.`;
  }

  /** A carried letter with no date, declined: no "act by" date (a Notice of Default's printed date is already past; a
   *  sale's is too late), so don't put it off. */
  async dontPutOff(id) {
    // A trustee's sale: reinstatement ends five business days before the sale date (Civ. Code § 2924c(e)), not on it.
    const sale = id === "ca-foreclosure-sale" ? `If you want to catch up on the loan, ${SALE_CUTOFF} ` : "";
    return `Don't put off dealing with ${theLetter((await this.letterInfo(id)).short)}. ${sale}Call back if you'd like to go over it, or look for free legal help. `;
  }

  /** The goodbye after an answer (after `prefix`: the text line, or the explanation). A letter still carried is named in
   *  it: an undated one "Don't put off …", a dated one or a carried question "call back with its date / about it". */
  async leave(prefix = "Okay. ", acted = prefix !== "Okay. ") {
    const undated = async (id) => !CARRIED_ASKS.has(id) && (await this.letterInfo(id)).needs_date === false;
    let line = "", rest = this.carry;
    if (rest.length && await undated(rest[0])) { line = await this.dontPutOff(rest[0]); rest = rest.slice(1); }
    // Every other letter carried is named too ("…the jury summons. You also mentioned the 60-day notice to move out: …").
    if (rest.length) {
      const names = [];
      for (const c of rest) names.push(theLetter(CARRIED_ASKS.get(c)?.label ?? (await this.letterInfo(c)).short));
      const how = rest.length > 1 ? "about them" : CARRIED_ASKS.has(rest[0]) || await undated(rest[0]) ? "about it" : "with its date";
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      // Free legal help is said once: the "Don't put off" line already says it.
      line += `You also mentioned ${list}: call back right away ${how}${line ? "." : ", or look for free legal help."} `;
    }
    // A trustee's sale carried behind another letter: its cutoff is still said.
    if (this.carry.slice(1).includes("ca-foreclosure-sale")) line += `For the Notice of Trustee's Sale: if you want to catch up on the loan, ${SALE_CUTOFF} `;
    return this.end(prefix + line, acted);
  }

  /** End the call after `text`, unless the caller asked the line to stay ("no, don't hang up", "thanks, don't hang up"):
   *  then it stays open for another letter, whatever was said with it. */
  async end(text, acted = false) {
    if (!this.staying) { this.awaiting = null; return this.say(text + this.closing(), true); }
    // "Thanks, please don't hang up" (nothing done, no "no"): what was open stays open, and its question is asked again.
    // Something done on this turn (the text line, the explanation, a declined letter's goodbye) or a "no" closes it.
    // At an open date question (the date stage, or a carried letter's date) a no said with the stay isn't a no to the
    // letter: the question stays too.
    const dateAsk = this.before && (this.before.awaiting === "date" || (this.before.awaiting === "another" && this.before.carry[0]
      && !CARRIED_ASKS.has(this.before.carry[0]) && (await this.letterInfo(this.before.carry[0])).needs_date !== false));
    if (!acted && (!this.saidNo || dateAsk) && this.before) {
      const { result, ...snap } = this.before;
      Object.assign(this, snap, { result, carry: [...snap.carry], candidates: [...snap.candidates] });
      const ask = await this.openQuestion();
      if (ask) return this.say(`Okay. ${ask}`);
    }
    this.reset(); this.awaiting = "another";
    return this.say(`${text}I'm still here: tell me about another letter, or say goodbye when you're done.`);
  }

  /** The question open at this stage, to ask again (null when nothing is open). */
  async openQuestion() {
    const [id] = this.carry;
    switch (this.awaiting) {
      case "date": return this.date && this.letter ? this.confirmQuestion() : this.dateQuestion ?? ASK_DATE;
      case "letter": return this.lastSaid();
      case "stop": return STOP_OFFER;
      case "more": return "Want me to explain how I counted?";
      case "text": return "Would you like me to text you the date?";
      case "another":
        if (!id) return "Do you have another letter I can help with?";
        if (CARRIED_ASKS.has(id)) return CARRIED_ASKS.get(id).question;
        return (await this.letterInfo(id)).needs_date === false ? "Want me to go on to it?" : "What date is on it?";
      default: return null;
    }
  }

  closing() { return "This is general information, not legal advice. Goodbye."; }
  goodbye(before = "") { return this.end("Okay. " + before, before !== ""); }

  /** Does this turn name a letter, as the decoder hears it (a letter, a which-kind question, or one carried)? */
  async namesLetter(t, current = null) {
    // A failed or empty detection names nothing: the plain yes, no or goodbye is answered as before.
    let det;
    try { det = await this.call("detect_letter", this.args({ text: t })); } catch { return false; }
    if (det?.candidates?.length || det?.also_detected?.length || det?.also_asks?.length) return true;
    return Boolean(det?.recognized && det.letter_type !== current);
  }
}
