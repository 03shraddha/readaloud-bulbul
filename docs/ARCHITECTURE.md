# Architecture

Moved out of the top-level README to keep that file short. This is the
detailed technical reference for how Boyle is built.

## No build step, by design

There is no webpack/esbuild/rollup/tsc anywhere in this repo. Chrome MV3
does not allow `"type": "module"` on a manifest-declared content script, so
`src/content/loader.js` is a tiny classic script that does
`import(chrome.runtime.getURL('src/content/main.js'))`, real ES modules,
loaded dynamically, with zero tooling. The background service worker
natively supports `"type": "module"` and is declared as such directly.

`npm run check` (`scripts/check-syntax.mjs`) is the closest thing to a
build step: it walks `src/` and `backend/` and runs `node --check` against
every file so a typo can't reach the browser silently. It is a parser, not
a bundler, it does not resolve `import` specifiers, so it's safe to run
against in-progress scaffolding.

## Runtimes

Four cooperating runtimes, all plain ES modules:

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

- **The service worker never sees DOM.** It only ever sees plain JSON
  `ReadUnit[]` / `Sentence[]` payloads from the content script.
- **Extractors are pluggable and opaque.** Both the article extractor and
  the X/Twitter extractor implement the same `Extractor` interface. The DOM
  locator for a sentence never leaves the extractor. The highlighter asks
  the extractor to resolve a sentence into a live `Range` or `Element` at
  highlight time, which is what makes X's virtualized timeline safe to
  re-query instead of holding stale nodes.
- **Content and offscreen never talk directly.** Everything routes through
  the background service worker, which is also the only component that
  touches the network.
- **All shared vocabulary lives in `src/shared/`** (message names, storage
  schema, constants, text normalization), written once, read-only after.

See `docs/CONTRACTS.md` for the full message catalog, storage schema, and
backend API contract.

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
    widget.js / widget-styles.js / highlighter.js / icons.js
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
[`docs/CONTRACTS.md`](CONTRACTS.md) for the full spec.
