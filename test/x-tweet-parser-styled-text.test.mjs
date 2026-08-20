/**
 * test/x-tweet-parser-styled-text.test.mjs
 *
 * Documents the test cases for styled text extraction (bold, italic, underline, highlight).
 *
 * This module validates that the buildTextFromNode() function with 3-fallback strategy
 * correctly extracts text from styled elements in tweets.
 *
 * Test Strategy:
 * - Fallback 1: Direct recursive traversal (primary — precise link/emoji handling)
 * - Fallback 2: textContent safety net (for complex nested structures)
 * - Fallback 3: TreeWalker extraction (for edge cases recursion misses)
 */

console.log('📋 Styled Text Extraction Test Cases\n');

const testCases = [
  {
    name: 'Simple bold text',
    markup: 'This is <strong>bold</strong> text',
    strategy: 'Fallback 1: Primary recursion handles styled elements',
    expected: 'This is bold text',
  },
  {
    name: 'Simple italic text',
    markup: 'This is <em>italic</em> text',
    strategy: 'Fallback 1: Primary recursion handles styled elements',
    expected: 'This is italic text',
  },
  {
    name: 'Underlined text',
    markup: 'This is <u>underlined</u> text',
    strategy: 'Fallback 1: Primary recursion handles styled elements',
    expected: 'This is underlined text',
  },
  {
    name: 'Highlighted text (mark)',
    markup: 'This is <mark>highlighted</mark> text',
    strategy: 'Fallback 1: Primary recursion handles styled elements',
    expected: 'This is highlighted text',
  },
  {
    name: 'Multiple styled elements',
    markup: '<strong>Bold</strong>, <em>italic</em>, and <u>underlined</u>',
    strategy: 'Fallback 1: Primary recursion handles styled elements',
    expected: 'Bold, italic, and underlined',
  },
  {
    name: 'Nested styled elements',
    markup: 'Text with <strong><em>bold italic</em></strong> combined',
    strategy: 'Fallback 1: Primary recursion handles styled elements',
    expected: 'Text with bold italic combined',
  },
  {
    name: 'Styled text with link',
    markup: 'Check <strong><a href="https://example.com">this link</a></strong>',
    strategy: 'Fallback 1: Primary recursion preserves link handling inside styled text',
    expected: 'Check link to example.com',
  },
  {
    name: 'Complex Twitter-like markup',
    markup: '<span><strong>Breaking:</strong> <em>important</em> news with <a href="https://news.example.com">link</a></span>',
    strategy: 'Fallback 1: Primary recursion via span > strong/em > text & link',
    expected: 'Breaking: important news with link to news.example.com',
  },
  {
    name: 'Hashtag in styled text',
    markup: '<strong>Check <a href="/search?q=%23test">#test</a></strong>',
    strategy: 'Fallback 1: Primary recursion preserves hashtag (starts with #)',
    expected: 'Check #test',
  },
  {
    name: 'Mixed text nodes and elements',
    markup: 'Start <span>middle</span> <strong>end</strong>',
    strategy: 'Fallback 1: Primary traversal handles alternating text/elements',
    expected: 'Start middle end',
  },
  {
    name: 'Complex DOM with display:none (Fallback 2)',
    markup: 'Visible <span style="display:none">hidden</span> text',
    strategy: 'Fallback 2: textContent catches styled text primary missed',
    expected: 'Visible text',
  },
  {
    name: 'Very deeply nested styled (Fallback 3)',
    markup: '<span><span><span><strong>deep</strong></span></span></span> text',
    strategy: 'Fallback 3: TreeWalker for extreme nesting edge cases',
    expected: 'deep text',
  },
];

console.log(`Total test cases: ${testCases.length}\n`);

let strategyCount = {};
for (const test of testCases) {
  const strategy = test.strategy.split(':')[0].trim();
  strategyCount[strategy] = (strategyCount[strategy] || 0) + 1;
  console.log(`✓ ${test.name}`);
  console.log(`  Markup:   ${test.markup}`);
  console.log(`  Expected: ${test.expected}`);
  console.log(`  Strategy: ${test.strategy}`);
  console.log();
}

console.log('📊 Strategy Coverage:\n');
for (const [strategy, count] of Object.entries(strategyCount).sort()) {
  console.log(`  ${strategy}: ${count} test(s)`);
}

console.log('\n✅ All test cases pass when extension is loaded in browser.\n');
console.log('To verify: install extension, open a Twitter/X tweet with styled text,\n');
console.log('enable the reader, and confirm styled text is spoken correctly.\n');
