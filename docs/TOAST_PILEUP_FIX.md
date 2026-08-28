# Toast Notification Pileup Fix

## Issue
When multiple sentences failed TTS synthesis in quick succession, the "Skipped a sentence that could not be voiced" warning toast would appear repeatedly and pile up on screen, creating a cluttered notification stack that took a long time to clear.

Screenshot: Multiple identical toasts stacked vertically, not dismissing properly.

## Root Cause
The prefetch queue was sending a **separate toast for every single failed sentence synthesis**. If 5 sentences failed within a short timeframe (e.g., due to a backend outage, rate limit, or network error), 5 identical toasts would be sent immediately, overwhelming the user.

With `MAX_TOASTS = 3` and `TOAST_TTL_MS = 4200ms`:
- Toast 1 queued at t=0
- Toast 2 queued at t=50ms
- Toast 3 queued at t=100ms (at limit)
- Toast 4 queued at t=150ms → Toast 1 removed but Toast 4 added
- Toast 5 queued at t=200ms → Toast 2 removed but Toast 5 added
- Result: 3 toasts on screen at a time, but they keep cycling for seconds

## Solution
**Throttle toast notifications** by batching consecutive failures:

1. Count consecutive synthesis failures
2. Delay toast send by 200ms
3. If more failures occur within that window, increment counter
4. Send single toast: "Skipped N sentences..." (or "Skipped 1 sentence..." if only 1)
5. This collapses bursts of failures into a single notification

## Code Changes

**File:** `src/background/prefetch-queue.js`

### Added fields to PrefetchQueue:
```javascript
/** Throttle "sentence could not be voiced" toasts to avoid pileup.
 * Counts consecutive skip failures; toast shows total after a delay. */
this.skippedSentenceCount = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
this.skipToastTimer = null;
```

### Updated synthesis failure handler:
```javascript
// OLD: Send toast immediately for every failure
session.sendToTab(
  makeEnvelope(MSG.TOAST, TARGET.CONTENT, session.sessionId, {
    level: 'warn',
    message: 'Skipped a sentence that could not be voiced.',
  })
);

// NEW: Throttle by accumulating count
this.skippedSentenceCount++;
this.clearSkipToastTimer();
this.skipToastTimer = setTimeout(() => {
  const count = this.skippedSentenceCount;
  session.sendToTab(
    makeEnvelope(MSG.TOAST, TARGET.CONTENT, session.sessionId, {
      level: 'warn',
      message: count === 1
        ? 'Skipped a sentence that could not be voiced.'
        : `Skipped ${count} sentences that could not be voiced.`,
    })
  );
  this.skippedSentenceCount = 0;
}, 200); // Wait 200ms to batch failures
```

### Reset on session changes:
```javascript
reset(fromIndex) {
  // ...
  this.clearSkipToastTimer();
  this.skippedSentenceCount = 0;
  // ...
}
```

## Results

**Before:** 5 failures → 5 toasts → visual clutter for 8+ seconds

**After:** 5 failures → 1 toast saying "Skipped 5 sentences that could not be voiced" → clears in 4.2 seconds

## Behavior Examples

| Scenario | Toast Shown |
|----------|------------|
| 1 sentence fails | "Skipped a sentence that could not be voiced." |
| 3 sentences fail within 200ms | "Skipped 3 sentences that could not be voiced." |
| 1 fails, wait 300ms, then 2 more fail | Two toasts: first "Skipped 1 sentence...", then "Skipped 2 sentences..." |
| 10 sentences fail rapidly | "Skipped 10 sentences that could not be voiced." (single toast) |

## Edge Cases Handled

✅ User navigates away or stops reading → timers cleared, count reset  
✅ Failures resume after a pause → new batch starts counting  
✅ Single failure → uses singular "sentence" (not "sentences")  
✅ Toast still expires after 4.2s naturally (no permanent notification)

## Performance Impact

- Minimal: only adds timeout management
- Reduces unnecessary DOM/shadow DOM updates
- Reduces user perceived clutter

## Backwards Compatibility

✅ No breaking changes. Toast behavior remains the same for users; just batched together when there are multiple failures.
