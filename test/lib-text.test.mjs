import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayWidth, padEndToWidth, sanitizeMultilineText, sanitizeText, truncateToWidth, truncateWithEllipsis, wrapToWidth } from '../lib/text.mjs';

test('displayWidth counts CJK as two columns and combining marks as zero', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('刪除檔案'), 8);
  assert.equal(displayWidth('é'), 1);
  assert.equal(displayWidth('a中b'), 4);
});

test('sanitizeText flattens newlines, tabs and ANSI escapes into single spaces', () => {
  assert.equal(sanitizeText('git status\n\tls  src'), 'git status ls src');
  assert.equal(sanitizeText('\x1b[31mred\x1b[0m text'), 'red text');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText(42), '');
});

test('truncateToWidth never splits a wide character across the limit', () => {
  assert.deepEqual(truncateToWidth('中文字', 5), { text: '中文', width: 4 });
  assert.deepEqual(truncateToWidth('abcdef', 3), { text: 'abc', width: 3 });
});

test('truncateWithEllipsis keeps short text and marks cut text', () => {
  assert.equal(truncateWithEllipsis('short', 10), 'short');
  assert.equal(truncateWithEllipsis('a long description', 8), 'a long …');
  assert.equal(displayWidth(truncateWithEllipsis('階段 4：打字練習頁面', 12)) <= 12, true);
});

test('padEndToWidth pads by display width', () => {
  assert.equal(padEndToWidth('中', 4), '中  ');
  assert.equal(padEndToWidth('toolong', 3), 'toolong');
});

test('ANSI escapes take no columns when measuring or truncating', () => {
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3);
  assert.equal(displayWidth('\x1b[1m中\x1b[0m'), 2);
  assert.deepEqual(truncateToWidth('\x1b[1mabcdef', 3), { text: '\x1b[1mabc', width: 3 });
});

test('sanitizeMultilineText keeps line breaks but drops escapes and outer blank lines', () => {
  assert.equal(sanitizeMultilineText('\n\ngit status\r\n\tls  src   \n\n'), 'git status\n    ls  src');
  assert.equal(sanitizeMultilineText("cat <<'EOF'\n\nbody\nEOF"), "cat <<'EOF'\n\nbody\nEOF");
  assert.equal(sanitizeMultilineText('\x1b[31mred\x1b[0m\x07 text'), 'red  text');
  assert.equal(sanitizeMultilineText('a\rb'), 'a\nb');
  assert.equal(sanitizeMultilineText('  \n \n'), '');
  assert.equal(sanitizeMultilineText(null), '');
});

test('wrapToWidth hard-wraps by display width', () => {
  assert.deepEqual(wrapToWidth('abcdefgh', 3), { rows: ['abc', 'def', 'gh'], rowCount: 3 });
  assert.deepEqual(wrapToWidth('abc', 3), { rows: ['abc'], rowCount: 1 });
  assert.deepEqual(wrapToWidth('', 3), { rows: [''], rowCount: 1 });
});

test('wrapToWidth never splits a wide character and keeps combining marks with their base', () => {
  assert.deepEqual(wrapToWidth('中文字元', 5), { rows: ['中文', '字元'], rowCount: 2 });
  assert.deepEqual(wrapToWidth('a中文', 2), { rows: ['a', '中', '文'], rowCount: 3 });
  assert.deepEqual(wrapToWidth('abéc', 3), { rows: ['abé', 'c'], rowCount: 2 });
  // 寬度 1 放不下寬字：硬放一個字一行，不會無限迴圈
  assert.deepEqual(wrapToWidth('中文', 1), { rows: ['中', '文'], rowCount: 2 });
});

test('wrapToWidth ignores ANSI escapes for width and keeps them in place', () => {
  assert.deepEqual(wrapToWidth('\x1b[1mabcd\x1b[0m', 2), { rows: ['\x1b[1mab', 'cd\x1b[0m'], rowCount: 2 });
});

test('wrapToWidth stops collecting rows at the limit but still counts every row', () => {
  assert.deepEqual(wrapToWidth('abcdefghij', 2, 2), { rows: ['ab', 'cd'], rowCount: 5 });
  assert.deepEqual(wrapToWidth('abcdefghij', 2, 0), { rows: [], rowCount: 5 });
});
