/**
 * src/content/extract/lib/x-thread-grouper.js
 *
 * Turns a flat, DOM-order list of TweetData (see x-tweet-parser.js) into
 * ReadUnit[] (shared_contracts §0). This is where every SETTINGS-gated
 * policy decision lives — the parser stays purely structural.
 *
 *  - Consecutive plain tweets (not a retweet/quote/promoted) by the SAME
 *    author are merged into one ReadUnit of kind 'thread', id
 *    `thread:<firstStatusId>`, with a "Next in thread." cue SENTENCE
 *    inserted between members (a synthetic, virtual-anchor sentence — no
 *    DOM node represents it).
 *  - A retweet gets exactly ONE announcement sentence, "<Name> shared
 *    this.", gated on settings.announceRetweets (never one per line).
 *  - A quote tweet gets exactly ONE extra sentence, "Quoting <Name>: ...",
 *    i.e. one level of nesting (the parser never recurses into a
 *    quote-of-a-quote, so there's nothing deeper to flatten here).
 *  - A promoted tweet is either dropped entirely (settings.skipPromoted)
 *    or kept with a leading "Sponsored." sentence.
 *
 * Every Sentence's `locator` is `{ statusId, sentenceOrdinal, textFingerprint,
 * part }` — a plain, JSON-safe, NEVER-a-DOM-reference object (`part` tags
 * which slice of the tweet this sentence came from, so twitter.js's
 * resolveAnchor() can re-query the right sub-element live at highlight
 * time). `sentenceOrdinal` is local to the originating tweet (resets to 0
 * per member), not to the merged unit.
 */

import { normalizeForSpeech, isPunctuationOnly } from '../../../shared/text/normalize.js';
import { splitSentences } from '../../../shared/text/sentence-splitter.js';

const THREAD_CUE_TEXT = 'Next in thread.';

/**
 * @param {import('./x-tweet-parser.js').TweetData} tweetData
 * @param {{announceRetweets:boolean}} opts
 * @returns {Array<{text:string, part:string}>}
 */
function buildSentenceSpecs(tweetData, opts) {
  const specs = [];

  if (tweetData.isRetweet && opts.announceRetweets) {
    const name = tweetData.repostedByName || tweetData.authorName;
    specs.push({ text: `${name} shared this.`, part: 'social-context' });
  }

  const mainNormalized = normalizeForSpeech(tweetData.mainText);
  for (const s of splitSentences(mainNormalized)) {
    specs.push({ text: s, part: 'text' });
  }

  if (tweetData.quote) {
    const quoteText = normalizeForSpeech(tweetData.quote.text);
    const combined = `Quoting ${tweetData.quote.name}: ${quoteText}`;
    for (const s of splitSentences(combined)) {
      specs.push({ text: s, part: 'quote' });
    }
  }

  if (tweetData.poll?.options?.length) {
    specs.push({ text: `Poll options: ${tweetData.poll.options.join(', ')}.`, part: 'poll' });
  }

  if (tweetData.linkCard) {
    const title = tweetData.linkCard.title ? `. ${tweetData.linkCard.title}` : '';
    specs.push({ text: `${tweetData.linkCard.urlText}${title}.`, part: 'link-card' });
  }

  for (const alt of tweetData.images || []) {
    specs.push({ text: `Image described as: ${alt}.`, part: 'image' });
  }

  return specs;
}

/**
 * @param {string} unitId
 * @param {'tweet'|'thread'|'quote-tweet'} kind
 * @param {string|null} label
 * @param {Array<{statusId:string, specs:Array<{text:string, part:string}>}>} members
 * @param {object} meta
 * @returns {import('../../../shared/types.js').ReadUnit}
 */
function buildUnit(unitId, kind, label, members, meta) {
  const sentences = [];
  let localIndex = 0;

  members.forEach((member, memberIdx) => {
    if (memberIdx > 0) {
      const cueText = normalizeForSpeech(THREAD_CUE_TEXT);
      if (!isPunctuationOnly(cueText)) {
        sentences.push({
          id: `${unitId}::${localIndex}`,
          unitId,
          index: -1, // assigned later by content/main.js
          text: cueText,
          languageCode: 'en-IN',
          anchorKind: 'virtual',
          locator: {
            statusId: member.statusId,
            sentenceOrdinal: -1,
            textFingerprint: 'thread-cue',
            part: 'thread-cue',
          },
        });
        localIndex++;
      }
    }

    member.specs.forEach((spec, ordinal) => {
      const text = normalizeForSpeech(spec.text);
      if (isPunctuationOnly(text)) return;

      const anchorKind = spec.part === 'thread-cue' ? 'virtual' : spec.part === 'text' || spec.part === 'quote' ? 'dom-range' : 'element';

      sentences.push({
        id: `${unitId}::${localIndex}`,
        unitId,
        index: -1, // assigned later by content/main.js
        text,
        languageCode: 'en-IN',
        anchorKind,
        locator: {
          statusId: member.statusId,
          sentenceOrdinal: ordinal,
          textFingerprint: text.slice(0, 48),
          part: spec.part,
        },
      });
      localIndex++;
    });
  });

  return { id: unitId, kind, label, sentences, meta };
}

/**
 * @param {import('./x-tweet-parser.js').TweetData[]} tweetDataList - DOM order
 * @param {{skipPromoted?:boolean, announceRetweets?:boolean}} [settings]
 * @returns {import('../../../shared/types.js').ReadUnit[]}
 */
export function groupTweetsIntoUnits(tweetDataList, settings = {}) {
  const opts = {
    skipPromoted: settings.skipPromoted !== false,
    announceRetweets: settings.announceRetweets !== false,
  };

  const units = [];
  const list = tweetDataList || [];
  let i = 0;

  while (i < list.length) {
    const td = list[i];

    if (td.isPromoted && opts.skipPromoted) {
      i++;
      continue;
    }

    if (td.isPromoted || td.isRetweet || td.isQuote) {
      const specs = buildSentenceSpecs(td, opts);
      const finalSpecs = td.isPromoted ? [{ text: 'Sponsored.', part: 'promoted' }, ...specs] : specs;
      const label = td.isRetweet && opts.announceRetweets ? `${td.repostedByName || td.authorName} shared this` : null;

      units.push(
        buildUnit(
          `tw:${td.statusId}`,
          td.isQuote ? 'quote-tweet' : 'tweet',
          label,
          [{ statusId: td.statusId, specs: finalSpecs }],
          {
            statusId: td.statusId,
            rootStatusId: td.statusId,
            authorName: td.authorName,
            isRetweet: td.isRetweet,
            isPromoted: td.isPromoted,
            isQuote: td.isQuote,
            threadPosition: 'standalone',
            permalink: td.permalink,
          }
        )
      );
      i++;
      continue;
    }

    // Gather a run of consecutive plain tweets by the same author.
    let j = i + 1;
    while (
      j < list.length &&
      list[j].authorName === td.authorName &&
      !list[j].isRetweet &&
      !list[j].isQuote &&
      !list[j].isPromoted
    ) {
      j++;
    }

    const run = list.slice(i, j);
    if (run.length > 1) {
      units.push(
        buildUnit(
          `thread:${run[0].statusId}`,
          'thread',
          null,
          run.map((t) => ({ statusId: t.statusId, specs: buildSentenceSpecs(t, opts) })),
          {
            statusId: run[0].statusId,
            rootStatusId: run[0].statusId,
            authorName: td.authorName,
            isRetweet: false,
            isPromoted: false,
            isQuote: false,
            threadPosition: 'root',
            permalink: run[0].permalink,
            memberStatusIds: run.map((t) => t.statusId),
          }
        )
      );
    } else {
      units.push(
        buildUnit(
          `tw:${td.statusId}`,
          'tweet',
          null,
          [{ statusId: td.statusId, specs: buildSentenceSpecs(td, opts) }],
          {
            statusId: td.statusId,
            rootStatusId: td.statusId,
            authorName: td.authorName,
            isRetweet: false,
            isPromoted: false,
            isQuote: false,
            threadPosition: 'standalone',
            permalink: td.permalink,
          }
        )
      );
    }
    i = j;
  }

  // Drop units that ended up with zero speakable sentences (e.g. an
  // announce-gated-off retweet of an otherwise-empty tweet).
  return units.filter((u) => u.sentences.length > 0);
}
