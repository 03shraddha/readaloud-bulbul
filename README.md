# Boyle

Boyle is an unbranded, read-aloud Chrome extension. It works on any page —
articles, blogs, and other general websites, plus dedicated support for
X/Twitter timelines. Click the toolbar icon and it extracts the readable
content, splits it into sentences, synthesizes speech for each sentence via a
small backend proxy, and plays them back in order with live sentence
highlighting.

> **Working codename.** "Boyle" is a project codename, not a Sarvam
> product name. **No Sarvam name, logo, or wordmark may appear anywhere in
> this extension** — not in the manifest, the toolbar icon, the options
> page, in-page widget, or any user-facing copy. Backend responses and code
> comments may reference the upstream TTS vendor by necessity, but nothing
> shipped to the browser UI may carry Sarvam branding.

---

## Quick start

There is no hosted backend for this project. Each person runs the backend
on their own machine, with their own Sarvam API key. Two pieces run:
the backend proxy (holds your key, talks to Sarvam) and the extension
itself (loaded unpacked in Chrome).

**1. Get a Sarvam API key.** Sign up at [sarvam.ai](https://www.sarvam.ai)
and generate an API key from your account.

**2. Clone this repo and add your key.**
```bash
git clone https://github.com/03shraddha/readaloud-bulbul.git
cd readaloud-bulbul
cp backend/.env.example backend/.env
# open backend/.env and set:
# SARVAM_API_KEY=your_key_here
```

**3. Install and start the backend.**
```bash
cd backend && npm install && cd ..
npm run backend
```
Check it started correctly:
```bash
curl -s http://localhost:8787/v1/health
```
You should see `"mock": false` and `"has_api_key": true`. If you don't have
a key yet, run `npm run backend:mock` instead. It fakes the audio (a plain
tone) so you can try the extension without one.

**4. Load the extension in Chrome.**
- Go to `chrome://extensions`
- Turn on **Developer mode** (top-right)
- Click **Load unpacked**, and pick this repo's root folder (the one with
  `manifest.json`)
- Pin the toolbar icon

**5. Use it.**
- Open any page you want read aloud — an article, a blog post, or `x.com`
  (log in first for that one)
- Click the toolbar icon to start reading
- Use the floating widget for play/pause, speed, and skip

Your API key stays on your machine, in `backend/.env`. It is never sent to
Chrome, never bundled into the extension, and `.gitignore` keeps it out of
git.

### Current limits

- **No Chrome Web Store listing yet.** Installing it means loading it
  unpacked, as above.
- **No shared backend.** Everyone runs their own `backend/`, with their own
  key.
- **No rate limiting on the backend.** Don't point more than one person at
  the same running backend/key without adding that first.

For the full manual test checklist, see [`docs/TESTING.md`](docs/TESTING.md).
For the message/storage/API contracts, see [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

---

## Architecture

Four cooperating runtimes, all plain ES modules, **no build step, no
bundler, no TypeScript**:

```
┌─────────────────────────┐        chrome.tabs.sendMessage        ┌──────────────────────────┐
│  Content script (tab)   │ <────────────────────────────────────>│  Background service      │
│  src/content/loader.js  │        chrome.runtime.sendMessage      │  worker ("the brain")    │
│   -> src/content/main.js│                                        │  src/background/*.js     │
│                         │                                        │                          │
│  - extractor registry   │                                        │  - session state         │
│  - article/twitter      │                                        │  - sentence cursor       │
│    extractors           │                                        │  - TTS prefetch queue     │
│  - highlighter (Range /  │                                        │  - chrome.storage.local  │
│    CSS Custom Highlight) │                                        │  - offscreen lifecycle   │
│  - shadow-DOM widget UI  │                                        │  - HTTP -> backend proxy │
└─────────────────────────┘                                        └────────────┬─────────────┘
                                                                                  │
                                                    chrome.runtime.sendMessage    │  HTTP
                                                    (target-disambiguated)        │
                                                                  ┌───────────────▼──────────────┐
                                                                  │  Offscreen document           │
                                                                  │  src/offscreen/*.js            │        ┌─────────────────────────┐
                                                                  │  (chrome.offscreen,             │  HTTP  │  Backend proxy          │
                                                                  │   reason: AUDIO_PLAYBACK)       │◄──────►│  backend/ (Node+Express) │
                                                                  │  - A/B <audio> double buffer     │        │  POST /v1/synthesize     │
                                                                  │  - plays audio in index order    │        │  -> Sarvam Bulbul v3      │
                                                                  │  - emits SENTENCE_STARTED /       │        │  or MOCK_TTS=1 tone       │
                                                                  │    PLAYBACK_TICK / SENTENCE_ENDED │        └─────────────────────────┘
                                                                  └───────────────────────────────┘
```

Key invariants:

- **The service worker never sees DOM.** It only ever sees plain-JSON
  `ReadUnit[]` / `Sentence[]` payloads from the content script.
- **Extractors are pluggable and opaque.** Both the article extractor and
  the X/Twitter extractor implement the same `Extractor` interface. The DOM
  locator for a sentence never leaves the extractor — the highlighter asks
  the extractor to resolve a sentence into a live `Range` or `Element` at
  highlight time, which is what makes X's virtualized timeline safe to
  re-query instead of holding stale nodes.
- **Content and offscreen never talk directly** — everything routes through
  the background service worker, which is also the only component that
  touches the network.
- **All shared vocabulary lives in `src/shared/`** (message names, storage
  schema, constants, text normalization) — written once, read-only after.

See `docs/CONTRACTS.md` for the full message catalog, storage schema, and
backend API contract.

---

## No build step, by design

There is no webpack/esbuild/rollup/tsc anywhere in this repo. Chrome MV3
does not allow `"type": "module"` on a manifest-declared content script, so
`src/content/loader.js` is a tiny classic script that does
`import(chrome.runtime.getURL('src/content/main.js'))` — real ES modules,
loaded dynamically, with zero tooling. The background service worker
natively supports `"type": "module"` and is declared as such directly.

`npm run check` (`scripts/check-syntax.mjs`) is the closest thing to a
build step: it walks `src/` and `backend/` and runs `node --check` against
every file so a typo can't reach the browser silently. It is a parser, not
a bundler — it does not resolve `import` specifiers, so it's safe to run
against in-progress scaffolding.

---

## Running the mock backend

The backend wraps Sarvam Bulbul v3 (`POST https://api.sarvam.ai/text-to-speech`)
and holds the API key server-side. For local development without
credentials, run it in mock mode — it generates real, decodable WAV audio
(a quiet sine tone, duration proportional to text length) so the entire
pipeline (queueing, highlight timing, skip, resume) can be exercised
end-to-end with zero API keys:

```bash
npm run backend:mock     # MOCK_TTS=1 node backend/server.js
# or, with a real key:
cp backend/.env.example backend/.env   # then fill in SARVAM_API_KEY
npm run backend                        # node backend/server.js
```

The server listens on `http://localhost:8787` by default (see
`backend/config.js`). The extension's `manifest.json` declares
`http://localhost:8787/*` in `host_permissions` so the background service
worker can call it directly.

---

## Loading the unpacked extension

1. Start the backend (mock or real) as above.
2. In Chrome, go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this repository's root directory
   (the one containing `manifest.json`).
5. Pin the toolbar icon. Clicking it fires `chrome.action.onClicked` and
   activates reading on the current tab (there is deliberately no popup —
   see the PRD's trigger decision).

Reloading after a code change: click the refresh icon on the extension's
card in `chrome://extensions`, then reload the target tab.

---

## Directory map

```
manifest.json                MV3 manifest
package.json                 dev scripts only, no dependencies
scripts/
  make-icons.mjs              generates icons/*.png (no deps, raw PNG encoder)
  check-syntax.mjs             node --check over src/ + backend/

src/shared/                  foundation, read-only contracts for every task
  messages.js                  MSG catalog + envelope helpers
  constants.js                  all tunables/defaults
  types.js                      JSDoc @typedefs only, no runtime code
  hash.js                        fnv1a32 / normalizeUrl / contentHash
  keys.js                        contentKey + storage key builders
  storage.js                      chrome.storage.local accessors
  logger.js                       createLogger(scope)
  text/
    normalize.js                   normalizeForSpeech, describeUrl
    sentence-splitter.js            splitSentences

src/content/                 per-tab content script
  loader.js                    classic script, manifest-injected
  main.js                       in-page orchestrator
  extract/
    registry.js                  host -> extractor routing
    article.js                    generic-page extractor
    twitter.js                    x.com/twitter.com extractor
    lib/                          extractor-internal helpers
  ui/
    widget.js / widget-styles.js / highlighter.js / auto-scroll.js / icons.js
                                   floating widget + highlighting

src/background/              service worker ("the brain")
  service-worker.js / session.js / tts-client.js / prefetch-queue.js /
  persistence.js / offscreen-manager.js

src/offscreen/                audio playback document
  offscreen.html / offscreen.js / audio-queue.js

src/options/                  extension options page
  options.html / options.js / options.css

backend/                      Node 20 + Express TTS proxy
  server.js / config.js / routes/ / lib/ / test/

icons/                         placeholder toolbar icons (generated, no branding)

test/, docs/                   fixtures, contract-check harness, docs
```

Everything under `src/shared/` (message catalog, storage schema, constants,
text normalization) is the contract every other module builds on. See
[`docs/CONTRACTS.md`](docs/CONTRACTS.md) for the full spec.
