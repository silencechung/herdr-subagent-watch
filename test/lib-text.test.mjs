import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayWidth, padEndToWidth, sanitizeText, truncateToWidth, truncateWithEllipsis } from '../lib/text.mjs';

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
