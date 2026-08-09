# Cadence — Shared Contracts (reviewer copy)

This is the human-readable copy of the shared contracts every task conforms to. The
source of truth is always the **code** in `src/shared/` (`messages.js`,
`constants.js`, `storage.js`, `keys.js`, `hash.js`, `types.js`, `text/*`) — this
document is a guide for reviewers, not something any task should implement against
instead of the code. If this doc and the code ever disagree, the code wins and this
doc is stale.

See `test/harness/contract-check.mjs` for an executable version of the invariants in
§1 (message catalog), §3 (sentence splitting), and §4 (hashing / content keys) below.

---

## 0. Core data shapes

**Sentence** — the atomic unit of synthesis and highlighting.

| field | type | notes |
|---|---|---|
| `id` | string | `${unitId}::${localIndex}`, globally unique in the session |
| `unitId` | string | parent `ReadUnit.id` |
| `index` | number | assigned by `content/main.js`; monotonic 0..N for the whole session, never reused |
| `text` | string | normalized, TTS-ready; **≤ 900 chars** (`MAX_SENTENCE_CHARS`) |
| `languageCode` | string | BCP-ish Sarvam code, default `en-IN` |
| `anchorKind` | `'dom-range' \| 'element' \| 'virtual'` | `'virtual'` = nothing to highlight in-page |
| `locator` | object | opaque; written and read only by the owning extractor; **never sent off-page** |

**ReadUnit** — a paragraph, heading, tweet, or grouped thread. Has `id`, `kind`,
`label` (spoken prefix or `null`), `sentences[]`, and extractor-specific `meta`
(X uses `{ statusId, rootStatusId, authorName, isRetweet, isPromoted, isQuote,
threadPosition, permalink }`).

**ExtractResult** — `{ units, contentKey, contentHash, title, exhausted }`, returned
by `extractor.extract()` / `extractMore()`. `exhausted: true` means no more content
will ever arrive for this session.

---

## 1. Extractor interface

Every extractor (`article.js`, `twitter.js`) default-exports:

```
{ id, matches(location), init(ctx), extract(), extractMore(reason),
  resolveAnchor(sentence), ensureVisible(sentence), dispose() }
```

- `extractMore(reason)` — `reason` is `'buffer-low'` or `'end-of-list'`. Must be
  idempotent (dedupe by `statusId`) and resolve within `EXTRACT_MORE_TIMEOUT_MS`
  (8000 ms) or return `{ units: [], exhausted: false }`.
- `resolveAnchor(sentence)` — called at highlight time, **after** `ensureVisible`.
  Returns `{kind:'range', range}` / `{kind:'element', element}` / `null`. `null`
  means the widget falls back to a text preview (§10).
- The registry (`content/extract/registry.js`) picks the module by host pattern;
  `article` is the universal fallback if the X module fails to load.

---

## 2. Message envelope

Every message: `{ type, target: 'background'|'content'|'offscreen', sessionId, payload }`.

- Receivers ignore messages whose `sessionId` doesn't match their current session.
- `content ⇄ background` uses `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`;
  `background ⇄ offscreen` uses `chrome.runtime.sendMessage`, disambiguated by `target`
  — every listener checks `env.target` first and returns early otherwise.
- All messages are fire-and-forget **except** `REQUEST_STATE`, the only message that
  expects a value back via `sendResponse` (a `PlaybackState`).
- Senders wrap `sendMessage` in try/catch and swallow the well-known "no receiver"
  errors (tab closed, service worker asleep, offscreen torn down).

---

## 3. Message catalog

See `src/shared/messages.js` (`MSG`) for the authoritative list — every value equals
its own key by construction, verified by the contract-check harness.

**content → background**: `CONTENT_READY`, `START_READING`, `APPEND_UNITS`,
`CONTROL_PLAY/PAUSE/TOGGLE/STOP/SKIP/SEEK/SET_RATE/SET_OPTION`, `REQUEST_STATE`,
`HIGHLIGHT_RESULT`, `RESUME_DECISION`.

**background → content**: `ACTIVATE`, `SESSION_STARTED`, `SESSION_ENDED`,
`PLAYBACK_STATE`, `HIGHLIGHT_SENTENCE`, `CLEAR_HIGHLIGHT`, `REQUEST_MORE_UNITS`,
`RESUME_AVAILABLE`, `TOAST`.

**background → offscreen**: `OFFSCREEN_INIT`, `SENTENCE_AUDIO_READY`, `AUDIO_PLAY`,
`AUDIO_PAUSE`, `AUDIO_STOP`, `AUDIO_SET_RATE`, `AUDIO_FLUSH`.

**offscreen → background**: `OFFSCREEN_READY`, `SENTENCE_STARTED`, `SENTENCE_ENDED`,
`PLAYBACK_TICK` (throttled ≥ `TICK_INTERVAL_MS` = 250 ms), `QUEUE_DRAINED`,
`BUFFER_LOW`, `PLAYBACK_ERROR`.

`CONTROL_SET_OPTION.key` is one of: `autoScroll`, `skipPromoted`, `announceRetweets`,
`highlightStyle`, `languageCode`, `speaker`, `backendBaseUrl` — background persists
the change into `ra.settings`. (Note: `rate`, `pace`, and `temperature` are not in
this key set — `rate` has its own `CONTROL_SET_RATE` message, and `pace`/`temperature`
are options-page-only settings with no live-session control message; see §7.)

---

## 4. PlaybackState

The single source of truth for the widget — it is a pure function of the last
`PLAYBACK_STATE`/`REQUEST_STATE` payload it received, never independent state:

```
{ sessionId, status: 'idle'|'extracting'|'buffering'|'playing'|'paused'|'stopped'|'error',
  index, sentenceId, unitId, unitLabel, currentText, totalSentences, exhausted,
  rate, queuedAhead, contentKey, kind: 'article'|'twitter'|null,
  error: {code, message} | null }
```

---

## 5. Text normalization + sentence splitting

`normalizeForSpeech(text)` — collapses whitespace, strips zero-width/variation-
selector chars, converts `…` → `.`, strips leading/trailing punctuation-only
fragments, drops bare URLs (extractors replace links with `"link to <domain>"`
first via `describeUrl()`).

`splitSentences(text, {maxChars = 900})` — `Intl.Segmenter('en', {granularity:
'sentence'})` when available, regex fallback otherwise. Protects `Mr.`, `Mrs.`,
`Ms.`, `Dr.`, `Prof.`, `e.g.`, `i.e.`, `U.S.`, `U.K.`, `vs.`, `No.`, `Fig.`,
`approx.`, `Jr.`, `Sr.`, `St.`, `etc.`, and decimals. Any resulting segment over
`maxChars` is re-split on `; : — ,`, then on whitespace, then hard-chunked by
character count as a last resort.

**Hard rule**: no produced sentence ever exceeds `MAX_SENTENCE_CHARS` = 900 (Bulbul's
own limit is 2500; 900 keeps per-sentence latency down).

---

## 6. Identity / keying

Hashing is **FNV-1a 32-bit**, 8 lowercase hex chars, synchronous — deliberately
**not** `crypto.subtle` (undefined on non-secure/plain-http origins).

`normalizeUrl(url)`: lowercase host, strip `#hash`, strip one trailing slash (but
keep a bare `/`), drop params matching
`/^(utm_|fb|gc|mc_|ref|ref_src|s|t|si|igshid|cmpid|spm)/i`, sort what's left.

| kind | contentKey |
|---|---|
| article | `article:${fnv1a32(normalizeUrl(url))}:${contentHash}`, where `contentHash = fnv1a32(sentences.map(s => s.text.slice(0,64)).join('') + '\|' + sentences.length)` |
| twitter | `x:${contextId}`, `contextId` derived from `location.pathname`/`search` |

`contextId` table:

| pathname pattern | contextId |
|---|---|
| `/home` | `home` |
| `/i/status/<id>` or `/<user>/status/<id>` | `status:${rootStatusId}` |
| `/i/lists/<id>` | `list:${id}` |
| `/search?q=..` | `search:${fnv1a32(q)}` |
| `/<user>` (single segment, profile) | `profile:${user.toLowerCase()}` |
| anything else | `other:${fnv1a32(pathname)}` |

X progress is keyed by **last-read status ID**, never by scroll offset or index.

---

## 7. `chrome.storage.local` schema

Written **only** by the background service worker (content/offscreen never write
storage) — **except** the options page, which reads *and writes* `ra.settings`
directly through `src/shared/storage.js`, since it never runs inside a live
playback session and there is no `CONTROL_SET_OPTION` path for every settings
field (notably `rate`, `pace`, `temperature`).

- **`ra.settings`** — `schemaVersion`, `backendBaseUrl`, `rate` (one of `RATES`),
  `languageCode` (one of the 11 `SUPPORTED_LANGUAGES`), `speaker`, `pace`,
  `temperature`, `autoScroll`, `skipPromoted`, `announceRetweets`, `highlightStyle`
  (`gradient`|`solid`|`underline`), `widgetPosition`, `volume`, `mockBackend`.
- **`ra.progress.${contentKey}`** — per-content resume record: `index`, `unitId`,
  `sentenceId`, `previewText` (first 120 chars), `totalSentences`,
  `lastStatusId`/`readStatusIds` (X only), `updatedAt`.
- **`ra.progressIndex`** — `[{contentKey, updatedAt}]`, newest-first, capped at
  `MAX_PROGRESS_ENTRIES` = 200 (LRU eviction deletes the matching `ra.progress.*`
  key too).
- **`ra.session`** — single crash/SW-restart recovery snapshot.

Writes are debounced at `PROGRESS_SAVE_DEBOUNCE_MS` (2000 ms), flushed immediately
on pause/stop/session-end/`onSuspend`. An unknown or older `schemaVersion` record is
discarded, not migrated.

---

## 8. Backend HTTP API

Base URL: `settings.backendBaseUrl` (default `http://localhost:8787`).

- `POST /v1/synthesize` — `{text, language_code?, speaker?, pace?, temperature?,
  speech_sample_rate?, output_audio_codec?, client_request_id?}` →
  `{audio_base64, format, mime_type, sample_rate, duration_ms, char_count,
  client_request_id, request_id, mock}`. Errors are always
  `{error: {code, message, retryable, upstream_status}}`.
- `POST /v1/synthesize/batch` — up to 5 items, concurrency 3, partial failure is
  per-item (HTTP stays 200 unless the whole request is malformed).
- `GET /v1/health` — `{ok, mock, model, version, uptime_s, has_api_key}`. This is
  what the options page's **Test connection** button calls.
- `GET /v1/voices` — `{speakers, languages, defaults, codecs}`.
- **Mock mode** (`MOCK_TTS=1`, or auto when `SARVAM_API_KEY` is absent): generates a
  real, decodable 24 kHz mono WAV (220 Hz tone) with no upstream call and no
  dependencies; `duration_ms` is text-proportional and non-null only in mock mode.
  The extension must never branch on `mock` — it's informational only.

Extension retry policy: retry only when `retryable === true`, max 2 retries,
backoff 400 ms then 1200 ms + jitter. Non-retryable → skip that sentence, `TOAST`
warning, advance.

---

## 9. Audio pipeline rules

- Background stays `PREFETCH_AHEAD` (3) sentences ahead, `TTS_CONCURRENCY` (2)
  in-flight, and drops all in-flight work on skip/seek/stop.
- Offscreen plays strictly in ascending `index`; out-of-order arrivals wait for
  their predecessor; anything with `index < currentIndex` is discarded.
- `audio.playbackRate = rate; audio.preservesPitch = true` on both buffers.
- `QUEUE_DRAINED` + `exhausted:false` → `REQUEST_MORE_UNITS`, status `buffering`.
  `exhausted:true` → session ends with reason `completed`.
- The Web Speech API is never used.

---

## 10. Highlight / fallback protocol

On `HIGHLIGHT_SENTENCE`: `ensureVisible` → `resolveAnchor` → apply highlight (CSS
Custom Highlight API, or a `<span class="cadence-hl">` Range fallback, or an
Element class toggle) → send `HIGHLIGHT_RESULT`. A `null` anchor (including the
**unmounted-tweet** case on X's virtualized timeline) means the widget shows the
text preview instead — this never blocks playback. All injected UI lives in a
Shadow DOM root (`#cadence-root`).

---

## 11. Constants

Single source of truth: `src/shared/constants.js`. Highlights: `MAX_SENTENCE_CHARS`
= 900, `BULBUL_MAX_CHARS` = 2500, `PREFETCH_AHEAD` = 3, `TTS_CONCURRENCY` = 2,
`TICK_INTERVAL_MS` = 250, `PROGRESS_SAVE_DEBOUNCE_MS` = 2000,
`MAX_PROGRESS_ENTRIES` = 200, `EXTRACT_MORE_TIMEOUT_MS` = 8000,
`RATES = [0.75,1,1.25,1.5,1.75,2]`, `SUPPORTED_LANGUAGES` = the 11 Bulbul codes
(`bn-IN, en-IN, gu-IN, hi-IN, kn-IN, ml-IN, mr-IN, od-IN, pa-IN, ta-IN, te-IN`),
`DEFAULT_SPEAKER = 'shubh'`, `GRADIENT_FROM = '#2F6BFF'`, `GRADIENT_TO = '#FF8A34'`.

---

## Branding note

Cadence is a project codename, not a Sarvam product. No Sarvam name, logo, or
wordmark appears anywhere in the manifest, icons, options page, or in-page widget —
only the neutral blue→orange gradient (`GRADIENT_FROM`/`GRADIENT_TO`) identifies it
visually.
