/**
 * src/shared/types.js
 *
 * JSDoc @typedef declarations only — ZERO runtime code. Gives editor-level
 * type checking without TypeScript. Every task should reference these via a
 * JSDoc comment, e.g.:
 *
 *   /** @type {import('../shared/types.js').Sentence} *\/
 *
 * See shared_contracts §0 (core data shapes), §4 (PlaybackState), and §3
 * (message payloads).
 */

/**
 * The atomic unit of synthesis + highlighting.
 * @typedef {Object} Sentence
 * @property {string} id - globally unique in session: `${unitId}::${localIndex}`
 * @property {string} unitId - parent ReadUnit id
 * @property {number} index - assigned by src/content/main.js; monotonic 0..N
 *   across the whole session, never reused, keeps increasing when e.g.
 *   twitter appends more units. This is the cursor/ordering key.
 * @property {string} text - normalized, TTS-ready. MUST be <= MAX_SENTENCE_CHARS.
 * @property {string} languageCode - BCP-ish Sarvam code, default 'en-IN'
 * @property {'dom-range'|'element'|'virtual'} anchorKind - 'virtual' = no
 *   in-page DOM to highlight; the highlighter shows a widget preview instead.
 * @property {object} locator - OPAQUE. Written by the extractor, read ONLY by
 *   that same extractor's resolveAnchor(). Never sent to background.
 */

/**
 * A paragraph, heading, tweet, or grouped thread.
 * @typedef {Object} ReadUnit
 * @property {string} id - article: `u${n}`; X: `tw:${statusId}` or `thread:${firstStatusId}`
 * @property {'heading'|'paragraph'|'list-item'|'quote'|'caption'|'code-summary'|'table-summary'|'tweet'|'thread'|'quote-tweet'|'poll'|'link-card'|'announcement'} kind
 * @property {string|null} label - spoken prefix, e.g. "Jane Doe shared this", "Next in thread"
 * @property {Sentence[]} sentences
 * @property {object} meta - extractor-specific, JSON-safe. X uses:
 *   { statusId, rootStatusId, authorName, isRetweet, isPromoted, isQuote,
 *     threadPosition, permalink }
 */

/**
 * Returned by extractor.extract() / extractMore().
 * @typedef {Object} ExtractResult
 * @property {ReadUnit[]} units
 * @property {string} contentKey
 * @property {string} contentHash
 * @property {string} title
 * @property {boolean} exhausted - true => no more content will ever arrive
 */

/**
 * Context passed to extractor.init().
 * @typedef {Object} ExtractorInitContext
 * @property {{debug:Function,info:Function,warn:Function,error:Function}} log
 * @property {Settings} settings
 */

/**
 * The pluggable per-host extractor interface. See shared_contracts §1.
 * @typedef {Object} Extractor
 * @property {'article'|'twitter'} id
 * @property {(location: Location) => boolean} matches - sync, cheap
 * @property {(ctx: ExtractorInitContext) => Promise<void>} init
 * @property {() => Promise<ExtractResult>} extract - first batch; sentences
 *   get NO .index yet
 * @property {(reason: 'buffer-low'|'end-of-list') => Promise<ExtractResult|null>} extractMore
 * @property {(sentence: Sentence) => Promise<{kind:'range', range: Range}|{kind:'element', element: Element}|null>} resolveAnchor
 * @property {(sentence: Sentence) => Promise<boolean>} ensureVisible
 * @property {() => void} dispose
 */

/**
 * Persisted per-content reading progress. See shared_contracts §7.
 * @typedef {Object} ProgressRecord
 * @property {number} schemaVersion
 * @property {string} contentKey
 * @property {'article'|'twitter'} kind
 * @property {string} url
 * @property {string} title
 * @property {string|null} contentHash - articles only
 * @property {number} index - absolute sentence index (articles: authoritative)
 * @property {string|null} unitId
 * @property {string|null} sentenceId
 * @property {string} previewText - first 120 chars
 * @property {number} totalSentences
 * @property {string|null} lastStatusId - X only; authoritative resume anchor
 * @property {string[]} readStatusIds - X only, ring buffer capped at 500
 * @property {number} updatedAt - epoch ms
 */

/**
 * Persisted user settings. See shared_contracts §7.
 * @typedef {Object} Settings
 * @property {number} schemaVersion
 * @property {string} backendBaseUrl
 * @property {number} rate
 * @property {string} languageCode
 * @property {string} speaker
 * @property {number} pace
 * @property {number} temperature
 * @property {boolean} autoScroll
 * @property {boolean} skipPromoted
 * @property {boolean} announceRetweets
 * @property {'gradient'|'solid'|'underline'} highlightStyle
 * @property {{x:number|null,y:number|null}} widgetPosition
 * @property {number} volume
 * @property {boolean} mockBackend
 */

/**
 * The single source of truth for the widget. See shared_contracts §4.
 * @typedef {Object} PlaybackState
 * @property {string|null} sessionId
 * @property {'idle'|'extracting'|'buffering'|'playing'|'paused'|'stopped'|'error'} status
 * @property {number} index - current sentence index, -1 when idle
 * @property {string|null} sentenceId
 * @property {string|null} unitId
 * @property {string|null} unitLabel
 * @property {string} currentText
 * @property {number} totalSentences
 * @property {boolean} exhausted
 * @property {number} rate
 * @property {number} queuedAhead
 * @property {string|null} contentKey
 * @property {'article'|'twitter'|null} kind
 * @property {{code:string, message:string}|null} error
 */

/**
 * Crash/SW-restart recovery snapshot. See shared_contracts §7.
 * @typedef {Object} SessionSnapshot
 * @property {string} sessionId
 * @property {number} tabId
 * @property {string} contentKey
 * @property {number} index
 * @property {string} status
 * @property {number} rate
 * @property {number} updatedAt
 */

// --- Message payload shapes (shared_contracts §3) ---

/**
 * @typedef {Object} ContentReadyPayload
 * @property {string} url
 * @property {string} host
 * @property {string} extractorId
 * @property {string} title
 */

/**
 * @typedef {Object} StartReadingPayload
 * @property {string} contentKey
 * @property {string} contentHash
 * @property {'article'|'twitter'} kind
 * @property {string} title
 * @property {string} url
 * @property {ReadUnit[]} units
 * @property {number} startIndex
 * @property {boolean} exhausted
 */

/**
 * @typedef {Object} AppendUnitsPayload
 * @property {ReadUnit[]} units
 * @property {boolean} exhausted
 */

/**
 * @typedef {Object} ControlSkipPayload
 * @property {'next'|'prev'} direction
 * @property {'sentence'|'unit'} granularity
 */

/**
 * @typedef {Object} ControlSeekPayload
 * @property {number} index
 */

/**
 * @typedef {Object} ControlSetRatePayload
 * @property {number} rate
 */

/**
 * @typedef {Object} ControlSetOptionPayload
 * @property {'autoScroll'|'skipPromoted'|'announceRetweets'|'highlightStyle'|'languageCode'|'speaker'|'backendBaseUrl'} key
 * @property {*} value
 */

/**
 * @typedef {Object} HighlightResultPayload
 * @property {string} sentenceId
 * @property {number} index
 * @property {boolean} ok
 * @property {'unmounted'|'no-anchor'|'detached'|'error'} [reason]
 */

/**
 * @typedef {Object} ResumeDecisionPayload
 * @property {string} contentKey
 * @property {boolean} accept
 * @property {number} index
 */

/**
 * @typedef {Object} SessionEndedPayload
 * @property {'user-stop'|'completed'|'navigation'|'error'} reason
 * @property {string} [message]
 */

/**
 * @typedef {Object} HighlightSentencePayload
 * @property {string} sentenceId
 * @property {string} unitId
 * @property {number} index
 * @property {string} text
 * @property {string|null} unitLabel
 * @property {number|null} durationMs
 */

/**
 * @typedef {Object} ClearHighlightPayload
 * @property {string} [sentenceId]
 */

/**
 * @typedef {Object} RequestMoreUnitsPayload
 * @property {'buffer-low'|'end-of-list'} reason
 * @property {number} queuedAhead
 */

/**
 * @typedef {Object} ResumeAvailablePayload
 * @property {string} contentKey
 * @property {number} index
 * @property {string} unitId
 * @property {string} previewText
 * @property {number} savedAt
 * @property {number} totalSentences
 */

/**
 * @typedef {Object} ToastPayload
 * @property {'info'|'warn'|'error'} level
 * @property {string} message
 * @property {string} [code]
 */

/**
 * @typedef {Object} OffscreenInitPayload
 * @property {string} sessionId
 * @property {number} rate
 * @property {number} startIndex - the Sentence.index playback starts at; the
 *   offscreen queue seeds its cursor with this so an out-of-order first
 *   arrival can't strand the true first sentence.
 */

/**
 * @typedef {Object} SentenceAudioReadyPayload
 * @property {string} sentenceId
 * @property {number} index
 * @property {string} audioBase64
 * @property {string} mimeType
 * @property {number} sampleRate
 * @property {number|null} durationHintMs
 */

/**
 * @typedef {Object} AudioSetRatePayload
 * @property {number} rate
 */

/**
 * @typedef {Object} AudioFlushPayload
 * @property {number} fromIndex
 */

/**
 * @typedef {Object} SentenceStartedPayload
 * @property {string} sentenceId
 * @property {number} index
 */

/**
 * @typedef {Object} SentenceEndedPayload
 * @property {string} sentenceId
 * @property {number} index
 * @property {number} durationMs
 */

/**
 * @typedef {Object} PlaybackTickPayload
 * @property {string} sentenceId
 * @property {number} index
 * @property {number} currentTimeMs
 * @property {number} durationMs
 */

/**
 * @typedef {Object} QueueDrainedPayload
 * @property {number} lastIndex
 */

/**
 * @typedef {Object} BufferLowPayload
 * @property {number} queuedCount
 */

/**
 * @typedef {Object} PlaybackErrorPayload
 * @property {string} sentenceId
 * @property {number} index
 * @property {'DECODE'|'ABORTED'|'NETWORK'|'UNKNOWN'} code
 * @property {string} message
 */

export {};
