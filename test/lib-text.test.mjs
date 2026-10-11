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
  ['8-bit CSI drops only the introducer', 'a\x9b31mb', 'a31mb'],
  ['8-bit OSC and ST drop only themselves', 'a\x9d0;title\x9cb', 'a0;titleb'],
  ['DCS string', 'a\x1bPq#0;2;0;0;0\x1b\\b', 'ab'],
  ['charset designation and save cursor', '\x1b(Ba\x1b7b', 'ab'],
  ['unterminated OSC loses only its introducer', 'tail \x1b]52;c;QUJD', 'tail 52;c;QUJD'],
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
  assert.equal(sanitizeMultilineText('line 1\x1b[2J\nline 2'), 'line 1\nline 2');
  assert.equal(sanitizeMultilineText('line 1\x9b2J\nline 2'), 'line 1 2J\nline 2');
});

test('an unterminated OSC / DCS drops only its introducer, and a lone 8-bit C1 never swallows the text after it', () => {
  // cp1252 亂碼：” 的 UTF-8 bytes E2 80 9D 被當成 cp1252 讀，0x9D 沒有對應字元，變成單獨的 U+009D
  assert.equal(sanitizeText('he said â€\x9dhello world, more text'), 'he said â€ hello world, more text');
  assert.equal(stripTerminalControls('he said â€\x9dhello'), 'he said â€hello');
  assert.equal(sanitizeMultilineText('line1 \x9d tail\nline2\nline3'), 'line1   tail\nline2\nline3');
  assert.equal(sanitizeMultilineText("printf '\x1b]0;title'\necho next\necho last"), "printf '0;title'\necho next\necho last");
  assert.equal(truncateToWidth('abc\x1bPdef ghi', 80).text, 'abcdef ghi');
  assert.equal(sanitizeText('a\x90b \x98c \x9ed \x9fe'), 'a b c d e');
  // ESC 後面不是 \ 就不是 ST：前面的 OSC 算沒結尾，只剝 introducer，ESC 開頭的序列另外剝
  assert.equal(stripTerminalControls('a\x1b]0;x\x1b[31mb'), 'a0;xb');
  // 有結尾的照舊整段剝掉，跨行也一樣
  assert.equal(sanitizeMultilineText('a\x1b]0;x\ny\x07b\nnext'), 'ab\nnext');
  assert.equal(stripTerminalControls('a\x1bP0;title\x9cb\x1b]q\x1b\\c'), 'abc');
});

test('8-bit C1 introducers are stripped one character at a time and never start a string sequence', () => {
  // latin1 亂碼：“ ” 的 UTF-8 bytes（E2 80 9C／E2 80 9D）被當成 latin1 讀，U+009D … U+009C 成對出現
  const mojibake = '\xe2\x80\x9ca\xe2\x80\x9d and \xe2\x80\x9cb\xe2\x80\x9d end';
  assert.equal(sanitizeText(mojibake), '\xe2 a\xe2 and \xe2 b\xe2 end');
  assert.equal(stripTerminalControls(mojibake), '\xe2a\xe2 and \xe2b\xe2 end');
  assert.equal(sanitizeMultilineText(mojibake + '\nnext'), '\xe2  a\xe2   and \xe2  b\xe2   end\nnext');
  // 8-bit CSI／OSC／DCS／SOS／PM／APC 都只拿掉自己，後面的參數與內容是普通文字
  assert.equal(stripTerminalControls('a\x9b2Jb'), 'a2Jb');
  assert.equal(stripTerminalControls('a\x9d0;title\x07b'), 'a0;titleb');
  assert.equal(stripTerminalControls('a\x90q#0\x9cb \x98s\x9c \x9ep\x9c \x9fx\x9c'), 'aq#0b s p x');
  // 7-bit 照舊：有結尾的整段剝掉，結尾也可以是 8-bit ST
  assert.equal(stripTerminalControls('a\x1b]0;title\x9cb'), 'ab');
  assert.equal(stripTerminalControls('a\x1b[2Jb'), 'ab');
});

test('stripping unterminated string sequences stays linear on adversarial input', () => {
  const length = 1_000_000;
  const inputs = [
    '\x9d' + 'a'.repeat(length),
    ('\x9d' + 'a'.repeat(99)).repeat(length / 100),
    ('\x1b]' + 'a'.repeat(96) + '\x1bX').repeat(length / 100),
    '\x9d' + '\x9b'.repeat(length),
    '\x9d\x9b\x90\x98\x9e\x9f'.repeat(length / 6),
  ];
  for (const input of inputs) {
    const startMs = performance.now();
    stripTerminalControls(input);
    sanitizeMultilineText(input);
    sanitizeText(input);
    const elapsedMs = performance.now() - startMs;
    // 線性時實測數十毫秒；平方時間是好幾分鐘，門檻放寬到不會因為機器忙而誤判
    assert.ok(elapsedMs < 5_000, `${JSON.stringify(input.slice(0, 8))}… took ${elapsedMs.toFixed(0)} ms`);
  }
});

test('ZWJ and ZWNJ are kept with zero width while other format characters are still removed', () => {
  const family = '👨\u200d👩\u200d👧';
  const persian = 'می\u200cخواهم';
  assert.equal(sanitizeText(`${family} ok`), `${family} ok`);
  assert.equal(sanitizeText(persian), persian);
  assert.equal(sanitizeMultilineText(`${family}\n${persian}`), `${family}\n${persian}`);
  assert.equal(stripTerminalControls(family), family);
  assert.equal(truncateWithEllipsis(family, 10), family);
  assert.equal(characterWidth('\u200d'), 0);
  assert.equal(characterWidth('\u200c'), 0);
  // 量的是各部分加總，terminal 把整串畫成一個字時會比較窄（docs/internals.md 已知限制）
  assert.equal(displayWidth(family), 6);
  assert.equal(displayWidth(persian), 7);
  assert.equal(stripTerminalControls('a\u202eb\u200bc\ufeffd\u2066e\u200ef'), 'abcdef');
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
