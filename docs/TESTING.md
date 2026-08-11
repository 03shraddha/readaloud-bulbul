# Manual QA script

This is the checklist for exercising Boyle end-to-end **without** a Sarvam API key
and without depending on live x.com/twitter.com being in any particular state. Pair
it with the automated pieces:

- `npm run check` — syntax-checks every file (parse only, no bundler).
- `node test/harness/contract-check.mjs` — asserts the shared-contract invariants
  (message catalog, sentence splitting, content-key derivation). Run this any time
  `src/shared/*` changes; it should print `All shared-contract invariants hold.`
  and exit 0.
- `node test/harness/session-recovery-check.mjs` — asserts the lazy
  service-worker-restart recovery path in `src/background/session.js`
  (`recoverSessionForTab()` / `resolveCurrent()`): a fresh snapshot is
  recovered as `paused`, a stale (past-TTL) or closed-tab snapshot is
  discarded, and a `CONTROL_*` message arriving with the content script's
  pre-restart `sessionId` recovers `current` instead of being silently
  dropped. Uses an in-memory `chrome.storage.local`/`chrome.tabs` stub (no
  real extension runtime needed). Run this any time
  `src/background/{session,persistence,service-worker}.js` changes; it
  should print `All service-worker-restart recovery invariants hold.` and
  exit 0.

Everything below is manual, because it depends on the real Chrome extension
runtime (`chrome.storage`, `chrome.tabs`, content-script injection, the offscreen
document) that a Node script cannot exercise.

---

## 0. Start the mock backend

No API key is required for any of this document.

```bash
npm run backend:mock     # MOCK_TTS=1 node backend/server.js, listens on :8787
```

Sanity-check it directly before touching the extension:

```bash
curl -s http://localhost:8787/v1/health | jq
#   -> { "ok": true, "mock": true, "model": "bulbul:v3", "has_api_key": false, ... }
curl -s -X POST http://localhost:8787/v1/synthesize \
  -H 'content-type: application/json' \
  -d '{"text":"Hello from the mock backend."}' | jq '.mock, .format, .duration_ms'
#   -> true, "wav", <some number>
```

If `has_api_key` is `false` and `MOCK_TTS` was **not** set, the server auto-enabled
mock mode and printed a startup warning — that's expected without
`backend/.env` containing a real `SARVAM_API_KEY`.

---

## 1. Load the unpacked extension

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
   the repo root (the directory containing `manifest.json`).
2. Confirm no load-time errors are shown on the extension's card. Click **service
   worker** (or **background page**) to open its console and watch for errors
   throughout the rest of this document.
3. Pin the toolbar icon.

> **Options page.** Right-click the toolbar icon → **Options** (or
> `chrome://extensions` → **Details** → **Extension options**) to reach
> `src/options/options.html`. `manifest.json` declares
> `"options_page": "src/options/options.html"`.

### 1a. Options page walkthrough

Open the options page and confirm, for every control, that reloading the page
afterwards shows the value you set (i.e. it round-trips through `ra.settings`):

- **Backend base URL** — leave as `http://localhost:8787`, click **Test
  connection**. Expect green `ok` / `live` / `has API key` badges to read
  `ok`, `mock`, and `no API key` respectively while the mock backend is running.
  Stop the backend and click **Test connection** again — expect a clear
  "Could not reach backend" message, not a silent failure or a thrown error in the
  console.
- **Default speed** — every value from `RATES` (0.75× … 2×) should be selectable.
- **Language** — all 11 codes appear, each with a readable label
  (e.g. "Hindi (hi-IN)").
- **Speaker**, **Pace**, **Temperature** — change each, confirm the on-page
  numeric readout for pace/temperature updates live as you drag.
- **Highlight style**, **Auto-scroll**, **Skip promoted tweets**, **Announce
  retweets** — toggle each; the "Saved" indicator in the footer should flash after
  every change.
- **Clear all saved reading positions** — see §4 below; do this *after* you've
  created at least one resumable session, not before.

Open the extension's storage from the service worker console
(`chrome://extensions` → service worker → Console) to cross-check:

```js
chrome.storage.local.get('ra.settings').then(console.log);
```

---

## 2. Fixture walkthrough (article extractor, T2)

Fixtures live in `test/fixtures/` and can be opened directly via `file://` (or
served statically, e.g. `npx serve test/fixtures`).

### 2a. `article-sample.html` — correctness target

Open the file, click the toolbar icon to activate reading. Expect:

- Nav, sidebar ("Trending now" / newsletter box), all three `.ad-slot` blocks, and
  the footer are **not** read.
- Reading order: title → byline is skipped or read once (implementation's call) →
  intro paragraph → "Why maintenance is invisible" section → the figure's
  **caption** is read (not just skipped) and the image's **alt text** is either
  read or intentionally folded into the caption — but not silently dropped →
  the numbered list (3 items, in order) → the blockquote (attributed) → the
  valve-cost paragraph → **some** summary of the table (not necessarily every
  cell verbatim, but the QA checker should be able to tell from the audio/preview
  that a cost comparison table was there) → the code block is **not** read
  verbatim character-by-character (a spoken summary like "a code block follows" is
  acceptable; reading `async function checkLinks(urls) {` aloud token-by-token is
  not) → conclusion paragraph.
- Abbreviations in the body text (`Dr.`, `U.S.`, `U.K.`, `Fig.`, `No.`, `approx.`,
  `Vs.`) must not cause mid-sentence highlight jumps or audible unnatural pauses.

### 2b. `article-hostile.html` — adversarial cases

Open the file and step through cases 1–7 using the widget's skip-forward control
(§3). For each case, confirm against the "Expect:" note printed in that section of
the page itself:

| # | Case | Pass criterion |
|---|---|---|
| 1 | `display:none` SEO text | Never read, never highlighted |
| 2 | `aria-hidden="true"` | Never read even though visually rendered |
| 3 | clip-rect off-screen paragraph | Never read despite non-zero `offsetWidth/Height` |
| 4 | flex `order` inversion | Read "Paragraph A" before "Paragraph B" (DOM order, not visual order) |
| 5 | open shadow root | The shadow-root paragraph **is** read |
| 6 | same-origin (`srcdoc`) iframe | Either read, or skipped — must not throw / must not stall extraction |
| 7 | cross-origin (`data:`) iframe | Skipped silently; no uncaught `DOMException` in the console |

If case 6 or 7 causes the whole extraction to stop short (nothing after that
section gets read), that's a bug — a failing iframe must be caught and skipped by
the extractor, not allowed to abort the pass.

---

## 3. Fixture walkthrough (X/Twitter extractor, T3)

Open `test/fixtures/x-timeline-sample.html`. This is a static mock — it does not
scroll-load more content — so use it to verify per-tweet parsing, not
`extractMore`/infinite-scroll behavior (see §5 for that, against live X).

Walk case A–G in order and confirm:

- **A (thread, statuses 1001–1003)** — all three tweets from `@ada_fixture` are
  read as a connected sequence ("1/3", "2/3", "3/3"), not as three disconnected
  standalone tweets, and not out of order.
- **B (retweet, 2001)** — the `socialContext` ("Rae Reposter reposted") is
  announced before the tweet body, per `announceRetweets` in settings; toggle that
  setting off in the options page and reload — the retweet should now play
  without the "reposted" announcement (still reads the tweet itself).
- **C (quote tweet, 3001/3002)** — both the quoting tweet's text and the quoted
  tweet's text are read, with enough of a verbal cue (e.g. reading the quoted
  author's name) that a listener can tell where one starts and the other ends.
- **D (promoted, 4001)** — with **Skip promoted tweets** on (default), this tweet
  is skipped entirely, advancing straight to the next unit. Toggle it off in
  options and reload — the tweet is now announced as sponsored/promoted and read.
- **E (poll, 5001)** — the question is read, and some sensible summary of the
  options/leading result is spoken (does not need to read every percentage, but
  should not silently skip the poll entirely).
- **F (link card, 6001)** — the tweet text is read; the link card is described
  (e.g. by domain/title) rather than read as a raw URL.
- **G (truncated "Show more", 7001)** — confirm the extractor either expands the
  tweet (via `ensureVisible`, clicking the `tweet-text-show-more-link` control) and
  reads the full text, or clearly announces that it's reading a truncated
  preview — it must not read the literal ellipsis/trailing "…" as if it were the
  end of the thought.

---

## 4. Resume checks

1. On `article-sample.html`, start reading, let 3–4 sentences play, then click the
   toolbar icon again (or however the widget exposes **stop**) to end the session
   mid-article.
2. Reload the same file (or revisit the same URL) and click the toolbar icon.
   Expect a `RESUME_AVAILABLE` prompt in the widget with a preview of the text you
   left off at. Accept it — confirm playback resumes at the right sentence, not
   from the top.
3. Repeat, but this time **decline** the resume prompt — confirm it restarts from
   the beginning and the previous progress record is not silently kept dangling
   forever (it's fine for it to still exist until eviction/clear; it must not
   crash or double-prompt).
4. Edit `article-sample.html` (change a sentence's wording), reload, and start a
   fresh session, stop partway, reload again. Confirm the **edited** version does
   *not* incorrectly offer to resume the old (pre-edit) position — the content
   hash changing should mint a new `contentKey` (see `docs/CONTRACTS.md` §6).
5. On the X fixture (or live X), confirm resume is keyed by the last-read
   **status ID**, not a scroll offset — i.e. resuming should not depend on the
   timeline having rendered the exact same set of tweets in the exact same DOM
   positions as before.
6. In the options page, click **Clear all saved reading positions**, confirm the
   status line acknowledges it and the counter drops to "No positions are
   currently saved." Then check storage directly:

   ```js
   chrome.storage.local.get(null).then((all) =>
     console.log(Object.keys(all).filter((k) => k.startsWith('ra.progress')))
   );
   // -> [] (no ra.progress.* keys and no ra.progressIndex key)
   ```

---

## 5. Live X walkthrough

Repeat the relevant parts of §3 against a real, logged-in `x.com` session (a
personal timeline with a healthy mix of retweets/promoted/threads works best):

- **`/home`** — start reading; confirm `REQUEST_MORE_UNITS`/`extractMore` kicks in
  as the buffer runs low (watch the service-worker console for `buffer-low`) and
  the extension scrolls the timeline itself (respecting `X_AUTOSCROLL_STEP_PX` /
  `X_AUTOSCROLL_MIN_INTERVAL_MS`) rather than requiring the user to scroll
  manually. Confirm it does not re-read tweets it has already spoken after a
  scroll-triggered re-render.
- **A single status page** (`/<user>/status/<id>`) — confirm the whole visible
  thread from that author is read, and that navigating to a reply's own status
  page mid-session is treated as a navigation (teardown + fresh session), not a
  crash.
- **A profile page** (`/<user>`) and **a search results page** (`/search?q=...`) —
  confirm each gets its own distinct `contentKey` (`profile:<user>` /
  `search:<hash>`) so progress doesn't bleed between a profile view and a search
  for that same person's name.

### 5a. Unmounted-tweet fallback check

This is the scenario `anchorKind: 'virtual'` / `resolveAnchor() -> null` exists
for: X virtualizes the timeline, so a tweet that was extracted a while ago may no
longer have a live DOM node by the time its turn to be highlighted comes up.

1. Start reading `/home` live, let it queue up several tweets.
2. While it's speaking an **earlier** tweet, manually scroll the timeline far
   down and back up rapidly a few times (encouraging X to unmount/remount tweet
   nodes), or open a different tab and let a while pass, then switch back.
3. When playback reaches a tweet whose DOM node has been recycled/removed,
   confirm:
   - No uncaught exception appears in either the content-script or background
     console.
   - The widget shows the **text preview fallback** (per `docs/CONTRACTS.md`
     §10) instead of a highlight, and a `HIGHLIGHT_RESULT{ok:false,
     reason:'unmounted'}` (or `'no-anchor'`/`'detached'`) is visible in the
     service-worker console if you're logging it.
   - Playback **continues** — a missed highlight must never pause or stop audio.

---

## 6. Skip / rate checks

- **Skip next/prev (sentence)** — during playback, confirm the current sentence's
  audio stops immediately (no overlap with the next), the highlight jumps
  accordingly, and prefetched audio for skipped-over sentences doesn't play late.
- **Skip next/prev (unit)** — confirm this moves a whole paragraph/tweet at a
  time, not just one sentence.
- **Seek** (if the widget exposes a scrubber/index jump) — jump forward several
  sentences and confirm the highlight and audio both land on the same sentence
  (no drift between what's highlighted and what's heard).
- **Rate** — change the default speed in the options page (§1a), start a new
  session, confirm it starts at that rate. Mid-session, change rate via the
  widget itself — confirm the pitch does not change (only the tempo), and that it
  takes effect immediately rather than only after the current sentence finishes.
- **Pause/resume** — pause mid-sentence, wait several seconds, resume — confirm
  it resumes the same sentence rather than restarting it or skipping ahead.

---

## Known issues / open items for reviewers

- **`options_page` manifest key.** Added during the integration pass;
  `manifest.json` now declares `"options_page": "src/options/options.html"`.
- `src/options/options.js` writes `ra.settings` **directly** via
  `src/shared/storage.js`'s `getSettings`/`patchSettings`, rather than round-
  tripping through a `CONTROL_SET_OPTION` message to the background service
  worker. This matches the task instructions for this file set and is safe
  because the options page never runs inside a live playback session (so there's
  no write race with `background/persistence.js`), and because `pace`/`temperature`
  have no `CONTROL_SET_OPTION` key to begin with (see `docs/CONTRACTS.md` §3). If a
  live session is open in another tab while you change settings, background-owned
  in-memory session state (e.g. current `rate`) will **not** hot-reload from this
  write — it takes effect on the next session start. Confirm this matches the
  background task's actual behavior once it lands, and flag a mismatch if not.
