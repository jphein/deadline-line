# Deadline Line

**Call a phone number, say what letter you got, hear your real deadline.**

For people without a smartphone, a data plan or the energy to read one more letter. The Deadline Line is a voice agent you reach by phone (or in the browser): describe your letter in your own words ("I got a letter from Social Security dated September 13th, they denied my disability again") and it answers with the exact deadline, how many days are left, what to do first and where to get free legal help. Then, if you ask, it explains how it counted.

- **Speech-to-text:** [AssemblyAI Universal-Streaming](https://www.assemblyai.com/docs/speech-to-text/universal-streaming) (v3 WebSocket), with key-term prompting for benefits and eviction vocabulary. 8 kHz from the phone, 16 kHz from the browser.
- **Deadline rules:** the Deadline Decoder MCP server, vendored in [`vendor/deadline-decoder-mcp/`](vendor/deadline-decoder-mcp/): tested code citing 20 CFR 404.933, CCP §§ 1161 and 1167, and W&I Code § 10951. **The AI never computes a date.**
- **Voice:** a local neural voice (Piper over the Wyoming protocol) or espeak-ng.
- **Phone:** runs on the project's own Asterisk, through its AudioSocket. Each call is a TCP stream of 8 kHz audio frames into this bridge.
- **Browser demo on Cloudflare Workers (or Vercel):** the page talks to AssemblyAI directly with a temporary token, and gets each reply from a serverless function that runs the same dialog over the same rules (below). Run locally, the browser demo goes through this server instead.

Hear it: [`docs/sample-call.ogg`](docs/sample-call.ogg), a real SIP call to the demo Asterisk (the caller's words were scripted for the rehearsal; the answer and the voice are real).

## Run

```bash
npm install
npm test                                   # 54 tests, no keys needed (fake AssemblyAI, fake TTS)
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

## Deploy on Cloudflare Workers
The browser demo runs as one Worker. [`worker.js`](worker.js) serves the page from `public/` (Workers Static Assets) and answers `/api/token`, `/api/decode` and `/api/healthz` with the platform-neutral handlers in [`src/handlers.js`](src/handlers.js). A Worker can't keep the audio WebSocket open for a whole call, so the page streams the microphone straight to AssemblyAI with a short-lived token from `/api/token` (the API key stays in the Worker). It posts each final transcript to `/api/decode`, which runs the same dialog and the same vendored rules as the phone line, and speaks the reply in the browser's own voice. The page finds out which mode it's in from `/api/healthz`.

```bash
npx wrangler secret put ASSEMBLYAI_API_KEY    # once; the key is a secret, never a var in wrangler.toml
npx wrangler deploy                           # the name, assets and bindings come from wrangler.toml
```
`https://deadline-line.<your-subdomain>.workers.dev/api/healthz` should then answer `{"ok":true,"stt":"assemblyai","mode":"direct","platform":"cloudflare-workers"}`. To try it locally first: `CLOUDFLARE_INCLUDE_PROCESS_ENV=true ASSEMBLYAI_API_KEY=... npx wrangler dev`, or put the key in a `.dev.vars` file, which git ignores.

## Or deploy on Vercel (free)
The same handlers run on Vercel's free Hobby plan, through the thin adapters in [`api/`](api/).

1. On vercel.com: **Add New → Project**, then import `jphein/deadline-line`. The production branch is the repo's default, `public`.
2. Leave the framework preset alone: [`vercel.json`](vercel.json) sets it to "Other", static `public/` plus the functions in `api/`.
3. Under **Environment Variables**, add `ASSEMBLYAI_API_KEY`.
4. **Deploy.** `https://<project>.vercel.app/api/healthz` should answer `{"ok":true,"stt":"assemblyai","mode":"direct","platform":"vercel"}`. Then open the page and call the line.

The phone line needs a PBX and the neural voice needs Piper or espeak-ng, so neither runs on Workers or Vercel. For those, run `npm start` somewhere that can.

## Running it as a public demo
Every conversation holds an AssemblyAI streaming session on your key, so the web demo limits itself. Each limit is an environment variable:

| Variable | Default | What it limits |
|---|---|---|
| `DEMO_SESSION_MAX_S` | 180 | seconds in one conversation; then the line says goodbye and hangs up |
| `DEMO_IDLE_S` | 45 | seconds with no speech, typing or reply before the line hangs up (silent mic audio doesn't count) |
| `DEMO_MAX_CONCURRENT` | 4 | conversations at once; the next visitor hears "the demo line is busy" |
| `DEMO_MAX_PER_IP` | 2 | conversations at once from one visitor |
| `DEMO_SESSIONS_PER_IP_HOUR` | 12 | new conversations per visitor per hour |
| `DEMO_DAILY_S` | 7200 | session time per UTC day, across all visitors |
| `DEMO_TTS_PER_IP_MIN` | 30 | `/tts` requests per visitor per minute |
| `DEMO_PACE_BURST_S` | 2 | how far audio may run ahead of real time; the rest is dropped |
| `DEMO_MAX_FRAME_BYTES` | 65536 | the largest WebSocket frame accepted |

Behind reverse proxies, set `TRUST_PROXY` to how many there are (usually `1`), so the per-visitor limits use that many `X-Forwarded-For` hops from the right, and keep `HOST=127.0.0.1` so only the proxy can reach the server. The global limits (at once, per day) bound the spend even if a visitor forges that header.

**On Cloudflare Workers and Vercel** no server sees a conversation, so the limits work on tokens instead. Each token must open its session within 60 seconds, and AssemblyAI itself ends that session at `DEMO_SESSION_MAX_S`. `/api/token` gives one visitor at most `DEMO_SESSIONS_PER_IP_HOUR` tokens an hour, and the whole demo `DEMO_DAILY_S / DEMO_SESSION_MAX_S` tokens a UTC day (40 by default). The page hangs up after `DEMO_IDLE_S` of silence, and it asks for a token only once the microphone is allowed, so someone who only types never opens a billed session. These counts live in memory, per Worker isolate or function instance (a Worker runs in many isolates across Cloudflare's network), so they're best effort. A token can also start more than one session inside its 60 seconds, so lower the per-visitor and daily caps for a busy demo. The other limits in the table apply only to `npm start`.

## Privacy
Sample letters only in demos. The bridge keeps each call's transcript in memory for the call's duration and writes nothing to disk. Audio goes to AssemblyAI for transcription and nowhere else. On Workers or Vercel, audio goes from the browser straight to AssemblyAI, and each final transcript goes to the decode function, which keeps nothing between requests.

## Known limits
No barge-in yet: while the line is speaking, the caller's words are ignored. California and federal rules only; eviction deadlines assume personal service. General information, not legal advice.

## License
MIT © 2026 Jeffrey Pine Hein, including `vendor/deadline-decoder-mcp/` (vendored from its MIT release by the same author). Built for [TechEMPOWER](https://techempower.org).
