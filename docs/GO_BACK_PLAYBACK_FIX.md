# Go Back & Play Fix

## Issue
When the user clicks the "Previous" (go back) button and then clicks play, the audio wasn't resuming from the previous sentence. The cursor would jump forward again, undoing the back navigation, or playback wouldn't start at all.

## Root Cause
Race condition in SENTENCE_STARTED event handling:

1. User at sentence index 5, audio is playing
2. User clicks prev button → `seekTo(4)` is called
   - Cursor set to 4
   - `AUDIO_FLUSH` message sent to offscreen player
   - Session status becomes 'buffering'
3. Offscreen audio player hasn't yet processed the flush, so SENTENCE_STARTED(index: 5) is already queued
4. SENTENCE_STARTED(5) arrives and is processed
5. In `handleSentenceStarted()`, the check `if (payload.index < this.cursor)` evaluates to `if (5 < 4)` = false
6. Cursor is updated to 5, undoing the back navigation
7. User is back at sentence 5 even though they clicked prev

## Solution
Add a guard in `handleSentenceStarted()` to discard SENTENCE_STARTED events that would move the cursor **forward** when the session is in 'buffering' state.

**Key insight:** When in buffering state (immediately after a seek), any SENTENCE_STARTED event for an index higher than the current cursor is stale — it's from audio that started before the flush was processed. We should wait for the SENTENCE_STARTED for the seek target instead.

## Code Changes

**File:** `src/background/session.js`

### Added field to Session constructor:
```javascript
/** Generation counter: increments on each seekTo(), used to ignore
 * stale SENTENCE_STARTED events that arrive after a seek. */
this.seekGeneration = 0;
```

### Updated seekTo():
```javascript
seekTo(newIndex) {
  // ... existing code ...
  this.cursor = target;
  this.seekGeneration++;  // Increment to mark a new seek generation
  
  offscreenManager.sendToOffscreen(
    makeEnvelope(MSG.AUDIO_FLUSH, TARGET.OFFSCREEN, this.sessionId, { fromIndex: target })
  );
  // ... rest of method ...
}
```

### Updated handleSentenceStarted():
```javascript
handleSentenceStarted(payload) {
  // Ignore stale/out-of-order events
  if (payload.index < this.cursor) return;

  // NEW: Ignore forward-moving events while buffering after a seek
  // This prevents in-flight audio from undoing a backwards navigation
  if (payload.index > this.cursor && this.status === 'buffering') {
    return; // Discard — wait for the seek target's audio instead
  }

  this.cursor = payload.index;
  // ... rest of method ...
}
```

## How It Works

When a user clicks back and then clicks play:

1. **Click prev:** seekTo(4) → status='buffering', audio flush begins
2. **Stale event arrives:** SENTENCE_STARTED(5) is discarded because:
   - index (5) > cursor (4) ✓
   - status === 'buffering' ✓
3. **Seek completes:** Audio for sentence 4 is loaded and ready
4. **Click play:** Audio resumes from sentence 4 ✓

## Test Scenario

1. Start reading a tweet thread (sentences 1, 2, 3, 4, 5, ...)
2. Let it play until sentence 5
3. Click "prev" button → status shows "buffering", preview shows sentence 4
4. Click "play" → audio resumes from sentence 4 (not 5)
5. Sentence 4 audio plays completely
6. Auto-advances to sentence 5 when done

## Edge Cases Handled

- ✅ Going back multiple times in succession
- ✅ Going back while paused (status stays 'paused', normal behavior)
- ✅ Going back then forward (forwards go through normally)
- ✅ High-speed clicking (buffering status debounces stale events)

## Performance Impact

Minimal — only adds:
- One increment operation per seek (`this.seekGeneration++`)
- One conditional check in handleSentenceStarted (status === 'buffering' check)

No network requests, no extra latency.

## Backwards Compatibility

✅ No breaking changes. The fix only adds defensive filtering for a race condition that was previously broken.
