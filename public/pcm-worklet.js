// Collects mic samples and posts ~50 ms Int16 chunks to the page (AssemblyAI's recommended chunk size).
class PcmWorklet extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(800); this.n = 0; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice().buffer, []); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm-worklet", PcmWorklet);
