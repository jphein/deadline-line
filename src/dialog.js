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
const BYE = /\b(bye|goodbye|that's all|that is all|hang up|thank you|thanks)\b/i;
// A goodbye said outright, not just thanks: "okay bye" is a goodbye, "no thanks" at an offer is still a no.
const FAREWELL = /\b(bye|goodbye|hang up)\b/i;
// A goodbye said negated asks the line to stay ("please don't hang up", "no need to say goodbye", "don't go"): it's taken
// out of the reply before the goodbye words are looked for.
const STAY = /\b(don'?t|do not|never|no need to|before you)\s+(\w+\s+)?(hang up|say (good)?bye)\b|\b(don'?t|do not) (go|leave)\b/i;
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
    const t = (text || "").trim();
    this.staying = STAY.test(t);   // "don't hang up": this turn doesn't end the call (end())
    if (!t) return this.say("Sorry, I didn't hear anything. " + GREETING);
    if (REPEAT.test(t) && !/\bdated\b|\bletter\b/i.test(t)) return this.say(this.last);
    // A yes, no or goodbye that also names a letter ("no, but I also got an eviction summons", "thanks, I also got an
    // unlawful detainer") is about that letter, not an answer to the question: the decoder decides, not a word list.
    // Right after an answer ("explain how I counted?", the text offer), the letter just answered doesn't count: "no, I
    // understand the 3 day notice" is a no. At the other stages it does ("yes, I also got a 3 day notice" at the stop offer).
    const current = this.awaiting === "more" || this.awaiting === "text" ? this.letter : null;
    const named = (YES.test(t) || NO.test(t) || BYE.test(t)) && await this.namesLetter(t, current);
    // "No" to the date question twice: go on to a letter the caller also named, or offer to stop, not the same ask again.
    const saidNo = this.dateNo; this.dateNo = false;
    if (this.awaiting === "date" && NO.test(t) && !named) {
      if (saidNo && this.carry.length) return this.startCarry("Okay. ");
      if (saidNo) { this.awaiting = "stop"; return this.say(STOP_OFFER); }
      this.dateNo = true;
    }
    // "Do you want to stop here?": a letter named in the reply ("yes, I also got a 3 day notice") is taken up, not a goodbye.
    // (A forged "stop" stage plus "yes" says goodbye without the offer having been made: self-only, like any stage the page
    // sends back; the state isn't authenticated.)
    const stay = this.staying, unsaid = stay ? t.replace(STAY_ALL, " ") : t;
    const bye = BYE.test(unsaid), farewell = FAREWELL.test(unsaid);
    // A yes with no goodbye in it ("yes thanks", "yes, please don't hang up"); one with a goodbye ("yes, bye", "okay bye")
    // is carried out, then the call ends.
    const yes = YES.test(t) && !farewell;
    // A no to stopping, with thanks or not ("no thanks", "no, that's all"), or a "don't hang up" asks the date again: the
    // caller can still say bye, while a call ended on a misread "no" loses the deadline. A goodbye said outright ("no thank
    // you, goodbye") ends it.
    if (this.awaiting === "stop" && !named) {
      if ((NO.test(t) && !farewell) || stay) { this.awaiting = "date"; return this.say(`Okay. ${this.dateQuestion ?? ASK_DATE}`); }
      if (YES.test(t) || bye) return this.goodbye();
    }

    // After an answer, a goodbye names a letter the caller also mentioned (leave()), so it isn't dropped unsaid.
    if (this.awaiting === "more" && !named) {
      const how = `Here's how I counted. ${this.result.how_we_counted_spoken} `;
      // A yes said with a goodbye ("yes, bye", "explain it, then hang up"): the explanation, then the goodbye.
      if ((HOW.test(t) || YES.test(t)) && farewell) return this.leave(how);
      if (HOW.test(t) || yes) { this.awaiting = "text"; return this.say(`${how}Would you like me to text you the date?`); }
      // A no said with a goodbye ("no thank you, goodbye") ends the call: it doesn't start the letter carried.
      if (NO.test(t) && !farewell && this.carry.length) return this.startCarry("Okay. ");
      if (NO.test(t) || bye) return this.leave();
    }
    if (this.awaiting === "text" && !named) {
      const texted = "Okay. In the real service I'd text the date and a calendar reminder to this number. ";
      // A letter the caller also named comes next, rather than the goodbye; not after a goodbye said with the yes or no.
      if (this.carry.length && (yes || (NO.test(t) && !farewell))) return this.startCarry(yes ? texted : "Okay. ");
      // A yes said with a goodbye ("yes, bye", "okay bye"): the text, then the goodbye.
      if (YES.test(t)) return this.leave(texted);
      if (NO.test(t) || bye) return this.leave();
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
      if (bye && !named && !((NO.test(t) || (yes && carry.length)) && !CARRIED_ASKS.has(carry[0]))) return this.goodbye();
      // A carried question first (not reached in real flows: answer() opens it itself; kept for a state the page sends).
      if (CARRIED_ASKS.has(carry[0])) return this.startCarry("");
      // "Want me to go on to it?" (a carried letter with no date to ask for): yes takes it up, no ends the call.
      if (carry.length && (await this.letterInfo(carry[0])).needs_date === false && !named) {
        // A no wins over a yes-word said with it ("yeah no thanks", "okay, no thanks", "no, okay go ahead"): a decline,
        // whose goodbye names the letter, so nothing is lost unsaid.
        if (NO.test(t)) return this.goodbye(await this.dontPutOff(carry[0]));
        if (YES.test(t)) return this.startCarry("");
      }
      if (!carry.length && NO.test(t) && !named) return this.goodbye();
      this.reset();
      // The letter the caller also named: this turn is about it (its date, or just "okay").
      if (carry.length) { [switched, ...this.carry] = carry; this.letter = switched; }
      else if (YES.test(t) && !named) return this.say("Okay. Tell me what kind of letter it is, and the date on it.");
    }
    const answered = this.awaiting === "more" || this.awaiting === "text";
    if (bye && !named) return this.goodbye();   // "bye, actually I have a jury summons" isn't a goodbye

    // A date answer has no letter in its words: say which letter we're on, so its date is read the right way
    // ("the due date was August 1st" looks back for a shutoff notice).
    const det = await this.call("detect_letter", this.args(this.candidates.length ? { text: t, among: this.candidates }
      : this.letter ? { text: t, letter_type: this.letter } : { text: t }));
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
    if (this.carry.length && det.recognized) this.carry = this.carry.filter(id => id !== det.letter_type);
    if (det.recognized && det.letter_type !== this.letter) { this.letter = det.letter_type; this.date = null; this.dateQuestion = det.date_question ?? null; }
    if (det.suggested_notice_date) this.date = det.suggested_notice_date;

    if (HOA.test(t)) this.hoa = true;   // "my HOA sent me a letter" → "what kind?" → "a notice of default"
    // A different sender named ("…actually it's from my mortgage lender") clears an earlier HOA mention; a corrected
    // letter from the same sender ("my HOA gave me a 3 day notice" → "actually it's a notice of default") doesn't.
    else if (LENDER.test(t)) this.hoa = false;
    if (switched && !det.recognized) {
      const info = await this.letterInfo(switched);
      if (!this.date && info.needs_date === false) return this.answer(t);
      if (!this.date) { this.awaiting = "date"; return this.say(`Okay, about ${info.short}. ${ASK_DATE}`); }
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
    const sale = id === "ca-foreclosure-sale" ? "If you want to catch up on the loan, the cutoff is generally five business days before the sale date, not the sale date itself. " : "";
    return `Don't put off dealing with ${theLetter((await this.letterInfo(id)).short)}. ${sale}Call back if you'd like to go over it, or look for free legal help. `;
  }

  /** The goodbye after an answer (after `prefix`: the text line, or the explanation). A letter still carried is named in
   *  it: an undated one "Don't put off …", a dated one or a carried question "call back with its date / about it". */
  async leave(prefix = "Okay. ") {
    const [id] = this.carry;
    let line = "";
    if (id && !CARRIED_ASKS.has(id) && (await this.letterInfo(id)).needs_date === false) line = await this.dontPutOff(id);
    else if (id) {
      const names = [];
      for (const c of this.carry) names.push(theLetter(CARRIED_ASKS.get(c)?.label ?? (await this.letterInfo(c)).short));
      line = `You also mentioned ${names.join(" and ")}: call back ${this.carry.length > 1 ? "about them" : CARRIED_ASKS.has(id) ? "about it" : "with its date"}, or look for free legal help. `;
    }
    return this.end(prefix + line);
  }

  /** End the call after `text`, unless the caller asked the line to stay ("no, don't hang up", "thanks, don't hang up"):
   *  then it stays open for another letter, whatever was said with it. */
  end(text) {
    if (!this.staying) { this.awaiting = null; return this.say(text + this.closing(), true); }
    this.reset(); this.awaiting = "another";
    return this.say(`${text}I'm still here: tell me about another letter, or say goodbye when you're done.`);
  }

  closing() { return "This is general information, not legal advice. Goodbye."; }
  goodbye(before = "") { return this.end("Okay. " + before); }

  /** Does this turn name a letter, as the decoder hears it (a letter, a which-kind question, or one carried)? */
  async namesLetter(t, current = null) {
    // A failed or empty detection names nothing: the plain yes, no or goodbye is answered as before.
    let det;
    try { det = await this.call("detect_letter", this.args({ text: t })); } catch { return false; }
    if (det?.candidates?.length || det?.also_detected?.length || det?.also_asks?.length) return true;
    return Boolean(det?.recognized && det.letter_type !== current);
  }
}
