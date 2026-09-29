// dialog.js — the conversation, written for the ear and for a phone keypad-less caller.
// Every fact comes from Deadline Decoder MCP tools; this file only decides what to ask next.

const YES = /\b(yes|yeah|yep|sure|ok|okay|please|go ahead|that's right|correct|right)\b/i;
const NO = /\b(no|nope|nah|not now|no thanks|that's wrong|wrong)\b/i;
const HOW = /\b(how|explain|counted|count|why)\b/i;
const REPEAT = /\b(repeat|again|say that again|what was that|pardon)\b/i;
const BYE = /\b(bye|goodbye|that's all|that is all|hang up|thank you|thanks)\b/i;

export const GREETING = "Deadline Line. Tell me what kind of letter you got and the date on it. For example: " +
  "a letter from Social Security dated September 13th, or eviction papers handed to me yesterday.";

export class Dialog {
  /** @param {(name: string, args: object) => Promise<any>} callTool  MCP tools/call, returns structuredContent */
  constructor(callTool, { today } = {}) {
    this.call = callTool;
    this.today = today;           // optional fixed date (tests / demos)
    this.letter = null; this.date = null; this.result = null; this.awaiting = null; this.last = GREETING;
  }

  args(extra) { return this.today ? { ...extra, today: this.today } : extra; }
  say(text, done = false) { this.last = text; return { say: text, done }; }

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
    if (BYE.test(t) && !/\bletter|notice|papers\b/i.test(t)) return this.goodbye();

    const det = await this.call("detect_letter", this.args({ text: t }));
    if (det.recognized && det.letter_type !== this.letter) { this.letter = det.letter_type; this.date = null; }
    if (det.suggested_notice_date) this.date = det.suggested_notice_date;

    if (this.letter && this.date) return this.answer();
    if (this.letter) {
      this.awaiting = "date";
      const ask = "What date is on it? You can say something like September 13th.";
      // Name the letter only when this turn is what identified it; otherwise just ask for the date again.
      return this.say(det.recognized && det.letter_title ? `Got it: ${det.letter_title}. ${ask}` : `I still need the date on the letter. ${ask}`);
    }
    this.awaiting = "letter";
    return this.say(this.date
      ? "Got the date. What kind of letter is it: Social Security, a landlord notice, eviction court papers, or Medi-Cal or CalFresh?"
      : "I can help with letters from Social Security, a landlord's three day notice, eviction court papers, or Medi-Cal and CalFresh. Which one did you get, and what date is on it?");
  }

  async answer() {
    const r = await this.call("compute_deadline", this.args({ letter_type: this.letter, notice_date: this.date }));
    // compute_deadline's speech is complete but long; on the phone, lead with the date and offer the rest.
    const counted = r.speech.match(/Here's how I counted\. (.*?) First step:/s)?.[1] ?? r.how_we_counted.join(" ");
    this.result = { ...r, how_we_counted_spoken: counted };
    this.awaiting = "more";
    const head = r.passed
      ? `That deadline was ${r.deadline_spoken}. It may not be too late: ask for more time in writing, and call free legal aid today.`
      : `Your deadline is ${r.deadline_spoken}. That's ${r.days_left === 1 ? "tomorrow" : r.days_left === 0 ? "today" : r.days_left + " days from today"}.`;
    return this.say(`${head} ${r.what_to_do}. First step: ${r.next_steps[0]} For free help, ${r.free_help[0].name}. Want me to explain how I counted?`);
  }

  closing() { return "This is general information, not legal advice. Goodbye."; }
  goodbye() { this.awaiting = null; return this.say("Okay. " + this.closing(), true); }
}
