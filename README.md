# Boyle

Boyle is a Chrome extension that reads web pages out loud.

## Demo

<video src="https://raw.githubusercontent.com/03shraddha/readaloud-bulbul/main/docs/media/demo.mp4" controls width="600"></video>

If the player above does not load, watch the file directly:
[`docs/media/demo.mp4`](docs/media/demo.mp4).

## What it does

- Reads articles, blogs, and most web pages aloud, sentence by sentence.
- Works on X (Twitter) too: reads tweets, threads, and long-form Articles.
- Highlights the sentence it is currently reading on the page.
- Skips images. Reads real captions if a page has them.
- Lets you play, pause, skip forward or back, and change speed.

## How to use it

1. Get a Sarvam API key at [sarvam.ai](https://www.sarvam.ai).
2. Clone this repo and add your key to `backend/.env` (copy it from
   `backend/.env.example` first).
3. Start the backend:
   ```bash
   cd backend && npm install && cd ..
   npm run backend
   ```
4. Load the extension in Chrome:
   - Go to `chrome://extensions`
   - Turn on **Developer mode**
   - Click **Load unpacked** and pick this repo's folder
   - Pin the toolbar icon
5. Open any page, then click the toolbar icon to start reading. Use the
   floating widget to play, pause, skip, or change speed.

No API key yet? Run `npm run backend:mock` instead. It plays a placeholder
tone so you can try the extension without one.

Your API key stays on your own machine. It is never sent to Chrome and
never committed to git.

## More docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), how the extension is
  built.
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md), the message and storage
  contracts.
- [`docs/TESTING.md`](docs/TESTING.md), the manual test checklist.
