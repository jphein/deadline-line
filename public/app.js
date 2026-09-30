const $ = (id) => document.getElementById(id);
let ws = null, ctx = null, stream = null, node = null, playing = Promise.resolve(), mutedUntil = 0;
// Two ways to place a call. "server": this page's own server holds the call (src/web.js, over /listen).
// "direct": the serverless demo on Cloudflare Workers or Vercel (src/handlers.js). No server there can hold a
// WebSocket, so the page streams to AssemblyAI itself with a temporary token and asks /api/decode for each reply.
let mode = "server", direct = null;
const inCall = () => Boolean(ws || direct);
const detected = fetch("api/healthz").then(r => (r.ok ? r.json() : null)).then((h) => {
  if (h?.mode !== "direct") return;
  mode = "direct";
  $("neural").checked = false; $("neural").closest("label").hidden = true;   // no neural voice there: the browser speaks
}).catch(() => {});

function setState(state, text) { $("handset").dataset.state = state; $("status").textContent = text; }
function line(who, text) {
  const li = document.createElement("li"); li.className = who; li.textContent = text;
  $("log").append(li); li.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Replies play in order; the mic keeps streaming, and the server ignores turns while it's answering.
function speak(text) {
  playing = playing.then(() => new Promise((resolve) => {
    setState("speaking", "Speaking…"); mutedUntil = Infinity;
    const done = () => { mutedUntil = Date.now() + 400; setState(inCall() ? "listening" : "idle", inCall() ? "Listening…" : "Ready"); resolve(); };
    if ($("neural").checked) {
      const a = new Audio("tts?text=" + encodeURIComponent(text));
      a.onended = done; a.onerror = () => { browserSpeak(text, done); };
      a.play().catch(() => browserSpeak(text, done));
    } else browserSpeak(text, done);
  }));
}
// The browser's own voice. Chrome can cut off a long utterance and never report its end, which would stall
// every later reply, so it speaks a sentence at a time and stops waiting after a generous estimate.
function browserSpeak(text, done) {
  if (!("speechSynthesis" in window)) return done();
  let over = false;
  const finish = () => { if (!over) { over = true; clearTimeout(guard); done(); } };
  const guard = setTimeout(finish, (text.split(/\s+/).length / 2 + 3) * 1000);
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.onerror = finish; if (i === parts.length - 1) u.onend = finish;
    speechSynthesis.speak(u);
  });
}

async function startCall() {
  $("call").textContent = "Hang up"; $("call").classList.add("hang");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/listen`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "partial") $("partial").textContent = m.text;
    else if (m.type === "caller") { $("partial").textContent = ""; line("caller", m.text); }
    else if (m.type === "line") { line("line", m.text); speak(m.text); if (m.done) playing.then(endCall); }
    else if (m.type === "error") line("error", m.text);
  };
  ws.onclose = () => endCall();
  $("t").disabled = $("send").disabled = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    node = new AudioWorkletNode(ctx, "pcm-worklet");
    node.port.onmessage = (e) => ws?.readyState === 1 && ws.send(e.data);
    ctx.createMediaStreamSource(stream).connect(node);
    setState("listening", "Listening…");
  } catch (err) {
    line("error", "No microphone available (" + err.message + "). You can type instead.");
    setState("listening", "Type below");
  }
}

// ---- Direct mode: the page does what src/web.js does on the server --------------------------------
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The line didn't answer (HTTP ${r.status}).`);
  return j;
}
async function openMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const c = new AudioContext({ sampleRate: 16000 });
  try {
    await c.audioWorklet.addModule("pcm-worklet.js");
    const n = new AudioWorkletNode(c, "pcm-worklet");
    c.createMediaStreamSource(s).connect(n);
    return { s, c, n };
  } catch (e) { closeMic({ s, c }); throw e; }
}
function closeMic(m) { m.s.getTracks().forEach(t => t.stop()); m.c.close(); }
// Idle means no speech heard, nothing typed and the line not speaking. It only runs while AssemblyAI is
// listening: a typed-only call opens no speech-to-text session, so leaving it open costs nothing.
function poke(call, extraS = 0) {
  if (!call.limits || call.over) return;
  clearTimeout(call.idle);
  call.idle = setTimeout(() => hangUp(call, call.limits.messages.idle), (call.limits.idle_s + extraS) * 1000);
}
function reply(call, r) {
  line("line", r.say); speak(r.say);
  poke(call, r.say.split(/\s+/).length / 2.4);          // the line's own talking isn't silence
  if (r.done) { call.over = true; clearTimeout(call.idle); closeStt(call); playing.then(() => direct === call && endCall()); }
}
function hangUp(call, text) {                           // the line ends the call itself
  if (direct === call && !call.over) reply(call, { say: text, done: true });
}
function closeStt(call) {
  const s = call.stt; call.stt = null;
  if (!s) return;
  s.onclose = s.onmessage = null;
  if (s.readyState === 1) { try { s.send(JSON.stringify({ type: "Terminate" })); } catch {} setTimeout(() => s.close(), 500); }
  else s.close();
}
async function heard(call, text) {
  $("partial").textContent = "";
  if (call.busy || call.over) return;                  // one answer at a time, like the phone line
  call.busy = true; line("caller", text);
  try {
    const r = await api("api/decode", { transcript: text, state: call.state });
    if (direct === call && !call.over) { call.state = r.state; reply(call, r); }
  } catch (e) { if (direct === call) line("error", e.message); }
  finally { call.busy = false; }
}

async function startDirect() {
  const call = direct = { state: null, busy: false, over: false, stt: null, began: false, limits: null, idle: null };
  $("call").textContent = "Hang up"; $("call").classList.add("hang");
  $("t").disabled = $("send").disabled = false;
  try {
    const hello = await api("api/decode");             // the line picks up
    if (direct !== call) return;
    call.state = hello.state; reply(call, hello);
  } catch (e) { line("error", e.message); return endCall(); }
  let mic;
  try { mic = await openMic(); } catch (err) {
    if (direct === call) { line("error", "No microphone available (" + err.message + "). You can type instead."); setState("listening", "Type below"); }
    return;
  }
  if (direct !== call) return closeMic(mic);           // hung up while the browser asked about the mic
  ({ s: stream, c: ctx, n: node } = mic);
  let t;
  try { t = await api("api/token"); } catch (e) {
    if (direct === call) { line("error", e.message); setState("listening", "Type below"); }
    return;
  }
  if (direct !== call) return;
  call.limits = t;
  const stt = call.stt = new WebSocket(t.url);
  stt.binaryType = "arraybuffer";
  stt.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "Begin") { call.began = true; poke(call); }
    else if (m.type === "Turn" && m.transcript) {
      poke(call);
      if (m.end_of_turn && m.turn_is_formatted) heard(call, m.transcript);
      else $("partial").textContent = m.transcript;
    } else if (m.error) line("error", "speech-to-text: " + m.error);
  };
  stt.onclose = (e) => {
    call.stt = null;
    if (!call.began) {                                  // never connected (a firewall, a refused token): typing still works
      call.limits = null;
      line("error", "Couldn't start speech-to-text" + (e.reason ? ` (${e.reason})` : "") + ". You can type instead.");
      return setState("listening", "Type below");
    }
    if (e.code !== 1000 && e.reason) line("error", "speech-to-text: " + e.reason);
    hangUp(call, t.messages.sessionEnd);                // AssemblyAI ended the session: time's up, or an error
  };
  // Half duplex, like the phone line: while the line talks, the mic sends silence, so its own voice
  // (the browser's speech often bypasses echo cancellation) isn't heard as the caller.
  node.port.onmessage = (e) => {
    if (call.began && stt.readyState === 1) stt.send(Date.now() < mutedUntil ? new ArrayBuffer(e.data.byteLength) : e.data);
  };
}

function endCall() {
  if (!ws && !stream && !direct) return;
  const call = direct; direct = null;
  if (call) { call.over = true; clearTimeout(call.idle); closeStt(call); }
  try { ws?.close(); } catch {}
  ws = null; stream?.getTracks().forEach(t => t.stop()); stream = null; ctx?.close(); ctx = null;
  $("call").textContent = "Call the line"; $("call").classList.remove("hang");
  $("t").disabled = $("send").disabled = true; $("partial").textContent = "";
  setState("idle", "Call ended");
}
let dialing = false;
$("call").onclick = async () => {
  if (inCall()) return endCall();
  if (dialing) return;
  dialing = true; await detected; dialing = false;     // server or direct: known once /api/healthz answers
  return mode === "direct" ? startDirect() : startCall();
};
$("typed").onsubmit = (e) => {
  e.preventDefault();
  const t = $("t").value.trim();
  if (!t) return;
  if (ws) ws.send(JSON.stringify({ type: "text", text: t }));
  else if (direct) { poke(direct); heard(direct, t.slice(0, 500)); }
  else return;
  $("t").value = "";
};
