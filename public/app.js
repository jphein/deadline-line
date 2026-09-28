const $ = (id) => document.getElementById(id);
let ws = null, ctx = null, stream = null, node = null, playing = Promise.resolve();

function setState(state, text) { $("handset").dataset.state = state; $("status").textContent = text; }
function line(who, text) {
  const li = document.createElement("li"); li.className = who; li.textContent = text;
  $("log").append(li); li.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Replies play in order; the mic keeps streaming, and the server ignores turns while it's answering.
function speak(text) {
  playing = playing.then(() => new Promise((resolve) => {
    setState("speaking", "Speaking…");
    const done = () => { setState(ws ? "listening" : "idle", ws ? "Listening…" : "Ready"); resolve(); };
    if ($("neural").checked) {
      const a = new Audio("tts?text=" + encodeURIComponent(text));
      a.onended = done; a.onerror = () => { browserSpeak(text, done); };
      a.play().catch(() => browserSpeak(text, done));
    } else browserSpeak(text, done);
  }));
}
function browserSpeak(text, done) {
  if (!("speechSynthesis" in window)) return done();
  const u = new SpeechSynthesisUtterance(text); u.onend = u.onerror = done; speechSynthesis.speak(u);
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
function endCall() {
  if (!ws && !stream) return;
  try { ws?.close(); } catch {}
  ws = null; stream?.getTracks().forEach(t => t.stop()); stream = null; ctx?.close(); ctx = null;
  $("call").textContent = "Call the line"; $("call").classList.remove("hang");
  $("t").disabled = $("send").disabled = true; $("partial").textContent = "";
  setState("idle", "Call ended");
}
$("call").onclick = () => (ws ? endCall() : startCall());
$("typed").onsubmit = (e) => { e.preventDefault(); const t = $("t").value.trim(); if (t && ws) { ws.send(JSON.stringify({ type: "text", text: t })); $("t").value = ""; } };
