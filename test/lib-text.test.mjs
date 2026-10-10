import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  characterWidth,
  displayWidth,
  padEndToWidth,
  sanitizeMultilineText,
  sanitizeText,
  stripTerminalControls,
  truncateToWidth,
  truncateWithEllipsis,
  wideRanges,
  wrapToWidth,
} from '../lib/text.mjs';

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

test('ANSI escapes take no columns and are dropped, not kept, when measuring or truncating', () => {
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3);
  assert.equal(displayWidth('\x1b[1m中\x1b[0m'), 2);
  assert.deepEqual(truncateToWidth('\x1b[1mabcdef', 3), { text: 'abc', width: 3 });
  assert.equal(truncateWithEllipsis('\x1b[31mok', 10), 'ok');
  assert.equal(padEndToWidth('\x1b[31mok', 4), 'ok  ');
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

test('wrapToWidth drops ANSI escapes instead of carrying them into the rows', () => {
  assert.deepEqual(wrapToWidth('\x1b[1mabcd\x1b[0m', 2), { rows: ['ab', 'cd'], rowCount: 2 });
});

test('wrapToWidth stops collecting rows at the limit but still counts every row', () => {
  assert.deepEqual(wrapToWidth('abcdefghij', 2, 2), { rows: ['ab', 'cd'], rowCount: 5 });
  assert.deepEqual(wrapToWidth('abcdefghij', 2, 0), { rows: [], rowCount: 5 });
});

// 除了 render.mjs 自己加的 SGR，輸出裡不能有任何 ESC、C0、C1、DEL 或 bidi／零寬字元
const terminalControlPattern = /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u;

const hostileSamples = [
  ['OSC 52 clipboard write ended by BEL', 'X\x1b]52;c;cHduZWQ=\x07Y', 'XY'],
  ['OSC 8 hyperlink ended by ST', 'Exp\x1b]8;;https://evil.example/\x1b\\click\x1b]8;;\x1b\\', 'Expclick'],
  ['CSI clear screen', 'a\x1b[2Jb', 'ab'],
  ['8-bit CSI', 'a\x9b31mb', 'ab'],
  ['8-bit OSC ended by 8-bit ST', 'a\x9d0;title\x9cb', 'ab'],
  ['DCS string', 'a\x1bPq#0;2;0;0;0\x1b\\b', 'ab'],
  ['charset designation and save cursor', '\x1b(Ba\x1b7b', 'ab'],
  ['unterminated OSC swallows the rest like a terminal would', 'tail \x1b]52;c;QUJD', 'tail '],
  ['bidi override and zero-width characters', 'a\u202eb\u2066c\u200bd\ufeffe', 'abcde'],
  ['lone C0, DEL and C1', 'a\x07b\x7fc\x85d\x1b', 'abcd'],
];

test('stripTerminalControls removes every escape sequence, control and format character', () => {
  for (const [name, input, expected] of hostileSamples) {
    const stripped = stripTerminalControls(input);
    assert.equal(stripped, expected, name);
    assert.doesNotMatch(stripped, terminalControlPattern, name);
  }
  assert.equal(stripTerminalControls('plain 中文 ✅'), 'plain 中文 ✅');
});

test('measuring, truncating and wrapping never let a hostile escape through', () => {
  for (const [name, input, expected] of hostileSamples) {
    assert.equal(displayWidth(input), displayWidth(expected), name);
    assert.doesNotMatch(truncateToWidth(input, 100).text, terminalControlPattern, name);
    assert.doesNotMatch(truncateWithEllipsis(input, 3), terminalControlPattern, name);
    assert.doesNotMatch(padEndToWidth(input, 30), terminalControlPattern, name);
    for (const row of wrapToWidth(input, 2).rows) {
      assert.doesNotMatch(row, terminalControlPattern, name);
    }
  }
});

test('sanitizeText and sanitizeMultilineText also strip 8-bit controls and bidi characters', () => {
  for (const [name, input] of hostileSamples) {
    assert.doesNotMatch(sanitizeText(input), terminalControlPattern, name);
    assert.doesNotMatch(sanitizeMultilineText(`${input}\n${input}`).replaceAll('\n', ''), terminalControlPattern, name);
  }
  assert.equal(sanitizeText('general-\u202epurpose'), 'general-purpose');
  assert.equal(sanitizeMultilineText('line 1\x9b2J\nline 2'), 'line 1\nline 2');
});

test('emoji and symbols with East Asian Width W or F take two columns', () => {
  for (const character of ['✅', '❌', '✨', '⭐', '⏳', '⌚', '⌛', '🚀', '🔥', '🤖', '🧪', '🫠', '🀄', '⬛', '〈', '\u3000', 'Ａ', '￥']) {
    assert.equal(characterWidth(character), 2, `${character} U+${character.codePointAt(0).toString(16)}`);
  }
  assert.equal(displayWidth('✅'), 2);
  assert.equal(displayWidth('🚀'), 2);
  assert.equal(displayWidth('done ✅ 🚀'), 10);
});

test('ambiguous and neutral symbols used by the interface stay one column', () => {
  for (const character of ['●', '✓', '◀', '▶', '│', '·', '─', '…', '↑', '↓', '✔', '❤', '☀', '🌡', 'ｱ']) {
    assert.equal(characterWidth(character), 1, `${character} U+${character.codePointAt(0).toString(16)}`);
  }
  assert.equal(displayWidth('●'), 1);
});

test('emoji are never split when truncating or wrapping', () => {
  assert.deepEqual(truncateToWidth('ab🚀c', 3), { text: 'ab', width: 2 });
  assert.deepEqual(wrapToWidth('a✅✅b', 3), { rows: ['a✅', '✅b'], rowCount: 2 });
});

test('the wide range table is sorted and non-overlapping for the binary search', () => {
  for (let index = 0; index < wideRanges.length; index += 1) {
    const [start, end] = wideRanges[index];
    assert.ok(start <= end, `range ${index}`);
    if (index > 0) {
      assert.ok(start > wideRanges[index - 1][1] + 1, `range ${index} overlaps or touches the previous one`);
    }
  }
});
