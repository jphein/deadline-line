# Deadline Line

**Call a phone number, say what letter you got, hear your real deadline.**

For people without a smartphone, a data plan or the energy to read one more letter. The Deadline Line is a voice agent you reach by phone (or in the browser): describe your letter in your own words ("I got a letter from Social Security dated September 13th, they denied my disability again") and it answers with the exact deadline, how many days are left, what to do first and where to get free legal help. Then, if you ask, it explains how it counted.

- **Speech-to-text:** [AssemblyAI Universal-Streaming](https://www.assemblyai.com/docs/speech-to-text/universal-streaming) (v3 WebSocket), with key-term prompting for benefits and eviction vocabulary. 8 kHz from the phone, 16 kHz from the browser.
- **Deadline rules:** the Deadline Decoder MCP server, vendored in [`vendor/deadline-decoder-mcp/`](vendor/deadline-decoder-mcp/): tested code citing 20 CFR 404.933, CCP §§ 1161 and 1167, and W&I Code § 10951. **The AI never computes a date.**
- **Voice:** a local neural voice (Piper over the Wyoming protocol) or espeak-ng.
- **Phone:** Asterisk's AudioSocket. Each call is a TCP stream of 8 kHz audio frames into this bridge.

Hear it: [`docs/sample-call.ogg`](docs/sample-call.ogg), a real SIP call to the demo Asterisk (the caller's words were scripted for the rehearsal; the answer and the voice are real).

## Run

```bash
npm install
npm test                                   # 10 tests, no keys needed (fake AssemblyAI, fake TTS)
ASSEMBLYAI_API_KEY=... TTS_WYOMING=host:10200 npm start
#   web demo:    http://127.0.0.1:8770/   (hold a conversation with your mic, or type)
#   AudioSocket: 127.0.0.1:9092           (for a local Asterisk)
```

`DD_MCP_URL` points at a running Deadline Decoder MCP server; if unset, the vendored copy starts in-process on 127.0.0.1:8766.

## Call it from a softphone (local demo PBX)

```bash
cd asterisk && ./setup.sh && docker compose up      # Asterisk 22, SIP on 127.0.0.1:5070 only, no trunks
```
Register any SIP softphone (Linphone, Zoiper, baresip) as user `caller` at `127.0.0.1:5070` (UDP), with the password `setup.sh` wrote to `asterisk/demo-auth.conf`, then **dial 3323** ("DEAD").

Rehearse without an AssemblyAI key: `node tests/fake-aai-server.mjs` and start the server with `AAI_STREAMING_URL=ws://127.0.0.1:8799/v3/ws ASSEMBLYAI_API_KEY=x`. The fake "hears" scripted sample lines on a timer.

Connecting a real PBX is deliberately out of scope for the demo: see [docs/PBX-INTEGRATION.md](docs/PBX-INTEGRATION.md).

## Privacy
Sample letters only in demos. The bridge keeps each call's transcript in memory for the call's duration and writes nothing to disk. Audio goes to AssemblyAI for transcription and nowhere else.

## Known limits
No barge-in yet: while the line is speaking, the caller's words are ignored. California and federal rules only; eviction deadlines assume personal service. General information, not legal advice.

## License
MIT © 2026 Jeffrey Pine Hein, including `vendor/deadline-decoder-mcp/` (vendored from its MIT release by the same author). Built for [TechEMPOWER](https://techempower.org).
