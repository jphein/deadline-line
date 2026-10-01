// dialog.js — the conversation, written for the ear and for a phone keypad-less caller.
// Every fact comes from Deadline Decoder MCP tools; this file only decides what to ask next.

const YES = /\b(yes|yeah|yep|sure|ok|okay|please|go ahead|that's right|correct|right)\b/i;
const NO = /\b(no|nope|nah|not now|no thanks|that's wrong|wrong)\b/i;
const HOW = /\b(how|explain|counted|count|why)\b/i;
// A request to repeat, said as the whole request (anchored at the start, so "they say I owe again" and "I read it
// again and it says…" are the caller's own words): "say (that) again", "tell me again", "read it again", "go over that
// again" (after "can/could/would/will you" or "please"), "again, please",
// "what did you say", "sorry, what?", or a bare "again", "huh" or "what". "They denied me again" isn't one.
const REPEAT = /\b(repeat|pardon|come again|one more time|what was that|what did you (just )?say)\b|^\W*((can|could|would|will) you |please )?(say|tell me|read( it| that)?|go over( it| that)?)\b( \w+){0,2} again\b|\bagain,? please\b|^\W*(sorry,? )?(again|huh|what)\W*$|^\W*sorry\W*$|^\W*sorry,? what\b/i;
const BYE = /\b(bye|goodbye|that's all|that is all|hang up|thank you|thanks)\b/i;
const LETTERISH = /\b(letter|notice|papers|summons|ticket|citation)\b/i;
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
  }

  args(extra) { return this.today ? { ...extra, today: this.today } : extra; }
  say(text, done = false) {
    this.last = text;
    if (done) { this.hoa = false; this.hoaSaid = false; }   // a finished conversation's HOA mention isn't the next one's
    return { say: text, done };
  }
  reset() { this.letter = null; this.date = null; this.result = null; this.awaiting = null; this.candidates = []; this.dateQuestion = null; this.hoa = false; this.hoaSaid = false; }

  /** The conversation so far, as plain JSON, for a host that keeps nothing between turns (the Vercel demo
   *  hands it to the page and gets it back with the next turn). The deadline isn't in it: restore() recomputes it. */
  snapshot() {
    return { letter: this.letter, date: this.date, awaiting: this.awaiting, last: this.last, candidates: this.candidates, dateQuestion: this.dateQuestion, hoa: this.hoa, hoaSaid: this.hoaSaid };
  }

  /** Pick a conversation back up from snapshot(). */
  static async restore(callTool, snap = {}, opts = {}) {
    const dialog = new Dialog(callTool, opts);
    dialog.letter = snap.letter ?? null; dialog.date = snap.date ?? null;
    dialog.awaiting = snap.awaiting ?? null; dialog.last = snap.last ?? GREETING;
    dialog.candidates = snap.candidates ?? []; dialog.dateQuestion = snap.dateQuestion ?? null; dialog.hoa = snap.hoa === true; dialog.hoaSaid = snap.hoaSaid === true;
    if (dialog.awaiting === "more") await dialog.compute();   // "how did you count?" reads the deadline
    return dialog;
  }

  async handle(text) {
    const t = (text || "").trim();
    if (!t) return this.say("Sorry, I didn't hear anything. " + GREETING);
    if (REPEAT.test(t) && !/\bdated\b|\bletter\b/i.test(t)) return this.say(this.last);

    if (this.awaiting === "more") {
      if (HOW.test(t) || YES.test(t)) {
        this.awaiting = "text";
        return this.say(`Here's how I counted. ${this.result.how_we_counted_spoken} Would you like me to text you the date?`);
      }
      if (NO.test(t) || BYE.test(t)) return this.goodbye();
    }
    if (this.awaiting === "text") {
      if (YES.test(t)) { this.awaiting = null; return this.say("Okay. In the real service I'd text the date and a calendar reminder to this number. " + this.closing(), true); }
      if (NO.test(t) || BYE.test(t)) return this.goodbye();
    }
    // "It's from my HOA", said after a notice of default or a trustee's sale was answered: the redemption right, once.
    if ((this.awaiting === "another" || this.awaiting === "more") && HOA_LETTERS.has(this.letter) && HOA.test(t) && !LETTERISH.test(t)) {
      const r = this.result ?? await this.compute();
      const step = r.next_steps.find(s => HOA_STEP.test(s));
      const ask = this.awaiting === "more" ? "Want me to explain how I counted?" : "Do you have another letter I can help with?";
      // Said once per letter: a repeated "it's from my HOA" hears that the step was covered, not the step again.
      if (step && this.hoaSaid) return this.say(`Yes, I've included the homeowners association step for this notice. ${ask}`);
      if (step) { this.hoaSaid = true; return this.say(`${step} ${ask}`); }
    }
    if (this.awaiting === "another") {         // after an answer with nothing to count: another letter?
      if ((NO.test(t) || BYE.test(t)) && !LETTERISH.test(t)) return this.goodbye();
      this.reset();
      if (YES.test(t) && !LETTERISH.test(t)) return this.say("Okay. Tell me what kind of letter it is, and the date on it.");
    }
    if (BYE.test(t) && !/\bletter|notice|papers\b/i.test(t)) return this.goodbye();

    // A date answer has no letter in its words: say which letter we're on, so its date is read the right way
    // ("the due date was August 1st" looks back for a shutoff notice).
    const det = await this.call("detect_letter", this.args(this.candidates.length ? { text: t, among: this.candidates }
      : this.letter ? { text: t, letter_type: this.letter } : { text: t }));
    this.candidates = det.candidates ?? [];   // a "which one?" question stays open for the next turn only
    if (det.recognized && det.letter_type !== this.letter) { this.letter = det.letter_type; this.date = null; this.dateQuestion = det.date_question ?? null; }
    if (det.suggested_notice_date) this.date = det.suggested_notice_date;

    if (HOA.test(t)) this.hoa = true;   // "my HOA sent me a letter" → "what kind?" → "a notice of default"
    // A different sender named ("…actually it's from my mortgage lender") clears an earlier HOA mention; a corrected
    // letter from the same sender ("my HOA gave me a 3 day notice" → "actually it's a notice of default") doesn't.
    else if (LENDER.test(t)) this.hoa = false;
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
    const next = counted ? "Want me to explain how I counted?" : "Do you have another letter I can help with?";
    // A second date or condition some letters carry (keep benefits while you wait; the 90-day rent date) comes next.
    const also = r.also_spoken ? ` ${r.also_spoken}` : "";
    // A caller who said it's their HOA foreclosing also hears the redemption right (the engine's own step, not a copy).
    // The HOA mention may come on an earlier turn than the answer, so it's carried in the state (cleanState keeps it).
    const hoa = HOA_LETTERS.has(r.letter_type) && (this.hoa || HOA.test(said)) ? r.next_steps.find(s => HOA_STEP.test(s)) : null;
    this.hoa = false;                   // said once, for this letter
    if (hoa) this.hoaSaid = true;
    return this.say(`${head} ${r.what_to_do}.${also} First step: ${r.next_steps[0]}${hoa ? ` ${hoa}` : ""} ${r.help_spoken ?? `For free help: ${r.free_help[0].name}, ${r.free_help[0].how}.`} ${next}`);
  }

  closing() { return "This is general information, not legal advice. Goodbye."; }
  goodbye() { this.awaiting = null; return this.say("Okay. " + this.closing(), true); }
}
