# Cadence backend — TTS proxy

Minimal Node 20 + Express service that wraps Sarvam Bulbul v3
(`POST https://api.sarvam.ai/text-to-speech`) and holds the API key
server-side, so it never reaches the browser extension. Express is the
**only** runtime dependency — no axios, no dotenv, no cors package, no
logger package. `.env` parsing is hand-rolled in `config.js`; CORS is a
~20-line middleware in `lib/cors.js`.

See `docs/CONTRACTS.md` (§8) in the repo root for the full contract this
implements.

## Running

```bash
cd backend
npm install

# Mock mode (no API key needed) — generates real, decodable WAV audio:
npm run start:mock          # MOCK_TTS=1 node server.js

# Real mode:
cp .env.example .env        # then set SARVAM_API_KEY
npm start                   # node server.js

# Smoke test (boots the server in mock mode on an ephemeral port):
npm test                    # node test/smoke.mjs
```

The server listens on `http://localhost:8787` by default.

If `SARVAM_API_KEY` is not set at all, the server **automatically** falls
back to mock mode and prints a loud startup warning — it never crashes or
silently no-ops.

## Environment variables

| Var                    | Default    | Meaning                                                                 |
| ----------------------- | ---------- | ------------------------------------------------------------------------ |
| `SARVAM_API_KEY`        | *(unset)*  | Bulbul v3 API key. Missing => mock mode auto-enabled.                    |
| `PORT`                  | `8787`     | HTTP port.                                                               |
| `MOCK_TTS`              | `0`        | `1`/`true`/`yes` forces mock mode even if a key is set.                  |
| `MOCK_LATENCY_MS`       | `250`      | Simulated latency per mock synthesis call.                              |
| `MOCK_FAIL_RATE`        | `0`        | 0..1 — fraction of mock calls that randomly return `UPSTREAM_ERROR`.     |
| `ALLOWED_ORIGINS`       | *(empty)*  | Comma-separated extra CORS origins, in addition to every `chrome-extension://` origin (always allowed). |
| `UPSTREAM_TIMEOUT_MS`   | `20000`    | Abort the upstream Sarvam call after this many ms (`UPSTREAM_TIMEOUT`).  |

## Endpoints

### `POST /v1/synthesize`

```bash
curl -s http://localhost:8787/v1/synthesize \
  -H 'content-type: application/json' \
  -d '{"text": "Hello from Cadence.", "language_code": "en-IN"}' | jq .
```

Success `200`:

```json
{
  "audio_base64": "...",
  "format": "mp3",
  "mime_type": "audio/mpeg",
  "sample_rate": 24000,
  "duration_ms": null,
  "char_count": 20,
  "client_request_id": null,
  "request_id": "...",
  "mock": false
}
```

In mock mode, `format`/`mime_type` are forced to `wav`/`audio/wav`
regardless of the requested `output_audio_codec`, `mock` is `true`, and
`duration_ms` is a real (non-null) text-proportional value — the only case
where `duration_ms` is non-null.

Error (any non-2xx), always shaped:

```json
{ "error": { "code": "TEXT_TOO_LONG", "message": "...", "retryable": false, "upstream_status": null } }
```

Codes: `INVALID_REQUEST` (400), `TEXT_TOO_LONG` (400), `UNSUPPORTED_LANGUAGE`
(400), `UNSUPPORTED_CODEC` (400), `UPSTREAM_AUTH` (502), `UPSTREAM_RATE_LIMIT`
(429), `UPSTREAM_TIMEOUT` (504), `UPSTREAM_ERROR` (502), `INTERNAL` (500).

### `POST /v1/synthesize/batch`

Max 5 items, concurrency 3, response order matches request order. Partial
failures are per-item; the HTTP status stays `200` unless the whole request
is malformed (e.g. missing/oversized `items`).

```bash
curl -s http://localhost:8787/v1/synthesize/batch \
  -H 'content-type: application/json' \
  -d '{
    "defaults": { "language_code": "en-IN" },
    "items": [
      { "id": "u1::0", "text": "First sentence." },
      { "id": "u1::1", "text": "Second sentence." }
    ]
  }' | jq .
```

```json
{
  "results": [
    { "id": "u1::0", "audio_base64": "...", "format": "mp3", "mime_type": "audio/mpeg", "sample_rate": 24000, "duration_ms": null, "request_id": "...", "mock": false },
    { "id": "u1::1", "error": { "code": "TEXT_TOO_LONG", "message": "...", "retryable": false } }
  ]
}
```

### `GET /v1/health`

```bash
curl -s http://localhost:8787/v1/health | jq .
```

```json
{ "ok": true, "mock": true, "model": "bulbul:v3", "version": "0.1.0", "uptime_s": 12, "has_api_key": false }
```

### `GET /v1/voices`

```bash
curl -s http://localhost:8787/v1/voices | jq .
```

```json
{
  "speakers": ["shubh"],
  "languages": ["bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"],
  "defaults": { "speaker": "shubh", "language_code": "en-IN", "pace": 1.0, "temperature": 0.6, "speech_sample_rate": 24000, "output_audio_codec": "mp3" },
  "codecs": ["wav", "mp3", "linear16", "mulaw", "alaw", "opus", "flac", "aac"]
}
```

## Logging

One line per request to stdout: method, path, char count, upstream
latency (ms), HTTP status, mock flag, total request time. The API key and
the base64 audio payload are never logged.

## Notes / assumptions

- The mime-type mapping for `alaw` is not specified in the shared contract;
  this implementation uses `audio/x-alaw-basic` as a reasonable convention.
  All other codec -> mime mappings are exactly as specified.
- CORS only echoes an origin (rather than using `*`) for `chrome-extension://`
  origins and anything listed in `ALLOWED_ORIGINS`; all other origins get no
  `Access-Control-Allow-Origin` header and will be blocked by the browser.
