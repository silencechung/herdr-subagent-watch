import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeyDecoder, createTabNumberInput, isDigitKey, tabNumberTimeoutMs } from '../lib/keys.mjs';

function createManualTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimer(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    runAll() {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

function decode(chunks) {
  const timers = createManualTimers();
  const keys = [];
  const decoder = createKeyDecoder((key, detail) => {
    keys.push(detail === undefined ? key : [key, detail]);
  }, timers);
  for (const chunk of chunks) {
    decoder.feed(chunk);
  }
  timers.runAll();
  return keys;
}

test('arrow keys decode in both CSI and SS3 forms', () => {
  assert.deepEqual(decode(['\x1b[D', '\x1b[C', '\x1bOD', '\x1bOC']), ['left', 'right', 'left', 'right']);
});

test('q, Ctrl+C and a lone Esc are reported as close keys', () => {
  assert.deepEqual(decode(['q']), ['q']);
  assert.deepEqual(decode(['\x03']), ['ctrl-c']);
  assert.deepEqual(decode(['\x1b']), ['escape']);
});

test('digits decode to themselves so they can jump to a tab number', () => {
  assert.deepEqual(decode(['1', '9', '0']), ['1', '9', '0']);
  assert.deepEqual(decode(['12']), ['1', '2']);
  assert.ok(isDigitKey('0') && isDigitKey('9'));
  assert.ok(!isDigitKey('other') && !isDigitKey('q') && !isDigitKey('12') && !isDigitKey(undefined));
});

test('an arrow sequence split across chunks is not mistaken for Esc', () => {
  assert.deepEqual(decode(['\x1b', '[C']), ['right']);
  assert.deepEqual(decode(['\x1b[', 'D']), ['left']);
});

test('several keys in one chunk decode in order', () => {
  assert.deepEqual(decode(['\x1b[C\x1b[C1\x1b[Dq']), ['right', 'right', '1', 'left', 'q']);
});

test('kitty keyboard protocol Esc and Ctrl+C are understood', () => {
  assert.deepEqual(decode(['\x1b[27u', '\x1b[99;5u']), ['escape', 'ctrl-c']);
});

test('Alt+letter is not treated as Esc', () => {
  assert.deepEqual(decode(['\x1bx']), ['other']);
});

test('up, down, page and home/end keys decode in every common form', () => {
  assert.deepEqual(decode(['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x1b[1;5A']), ['up', 'down', 'up', 'down', 'up']);
  assert.deepEqual(decode(['\x1b[5~', '\x1b[6~']), ['page-up', 'page-down']);
  assert.deepEqual(decode(['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']), ['home', 'home', 'home', 'home']);
  assert.deepEqual(decode(['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']), ['end', 'end', 'end', 'end']);
  assert.deepEqual(decode(['\x1b[2~', '\x1b[3~']), ['other', 'other']);
});

test('SGR mouse wheel sequences decode to wheel-up and wheel-down', () => {
  assert.deepEqual(decode(['\x1b[<64;10;5M', '\x1b[<65;10;5M']), ['wheel-up', 'wheel-down']);
  // Shift／Ctrl 加在 button 上：64 + 4、65 + 16
  assert.deepEqual(decode(['\x1b[<68;1;1M', '\x1b[<81;1;1M']), ['wheel-up', 'wheel-down']);
});

test('an SGR left-button press decodes to a click with its 1-based coordinates', () => {
  assert.deepEqual(decode(['\x1b[<0;42;3M']), [['click', { x: 42, y: 3 }]]);
  assert.deepEqual(decode(['\x1b[<0;1;1M']), [['click', { x: 1, y: 1 }]]);
  // Shift／Alt／Ctrl 的 4／8／16 和滾輪一樣不看
  assert.deepEqual(decode(['\x1b[<4;7;1M', '\x1b[<16;8;1M']), [['click', { x: 7, y: 1 }], ['click', { x: 8, y: 1 }]]);
});

test('SGR releases, other buttons and drags are ignored and never leak characters', () => {
  // herdr 每次點擊送 press 與 release 兩個事件：release 不能再算一次點擊
  assert.deepEqual(decode(['\x1b[<0;113;113M', '\x1b[<0;113;113m']), [['click', { x: 113, y: 113 }], 'other']);
  assert.deepEqual(decode(['\x1b[<0;113;113m', '\x1b[<64;1;1m']), ['other', 'other']);
  assert.deepEqual(decode(['\x1b[<1;5;1M', '\x1b[<2;5;1M', '\x1b[<32;5;1M']), ['other', 'other', 'other']);
  assert.deepEqual(decode(['\x1b[<0;0;1M', '\x1b[<0;;1M']), ['other', 'other']);
});

test('a click does not change how the wheel decodes', () => {
  assert.deepEqual(decode(['\x1b[<64;10;5M\x1b[<0;10;1M\x1b[<0;10;1m\x1b[<65;10;5M']), ['wheel-up', ['click', { x: 10, y: 1 }], 'other', 'wheel-down']);
});

test('an SGR mouse sequence split across chunks still decodes', () => {
  assert.deepEqual(decode(['\x1b[<6', '4;12;', '7M']), ['wheel-up']);
  assert.deepEqual(decode(['\x1b', '[<65;1;1M']), ['wheel-down']);
  assert.deepEqual(decode(['\x1b[<0;4', '2;', '3', 'M', '\x1b[<0;42;3', 'm']), [['click', { x: 42, y: 3 }], 'other']);
  assert.deepEqual(decode(['\x1b', '[', '<0;12;1M']), [['click', { x: 12, y: 1 }]]);
});

test('X10 mouse reports swallow their raw coordinate bytes', () => {
  // button 64 + 32 = '`'；座標 byte 是 q（113）時不能被當成關閉鍵
  assert.deepEqual(decode(['\x1b[M`qq']), ['wheel-up']);
  assert.deepEqual(decode(['\x1b[Maqq', 'q']), ['wheel-down', 'q']);
  assert.deepEqual(decode(['\x1b[M', '`qq']), ['wheel-up']);
});

function createTabNumberHarness(tabCount) {
  const timers = createManualTimers();
  const delays = [];
  const jumps = [];
  const input = createTabNumberInput((number) => {
    jumps.push(number);
  }, {
    setTimer(callback, delay) {
      delays.push(delay);
      return timers.setTimer(callback);
    },
    clearTimer: timers.clearTimer,
  });
  return {
    jumps,
    delays,
    timers,
    press(digits, count = tabCount) {
      for (const digit of digits) {
        input.press(digit, count);
      }
    },
    input,
  };
}

test('a digit that cannot start a longer tab number jumps right away', () => {
  const harness = createTabNumberHarness(14);
  harness.press('3');
  assert.deepEqual(harness.jumps, [3]);
  harness.press('9');
  assert.deepEqual(harness.jumps, [3, 9]);
  assert.deepEqual(harness.delays, []);
  const few = createTabNumberHarness(4);
  few.press('1');
  assert.deepEqual(few.jumps, [1]);
  assert.deepEqual(few.delays, []);
});

test('a digit that could start a longer number waits 600ms, then jumps to what was typed', () => {
  const harness = createTabNumberHarness(14);
  harness.press('1');
  assert.deepEqual(harness.jumps, []);
  assert.deepEqual(harness.delays, [tabNumberTimeoutMs]);
  assert.equal(tabNumberTimeoutMs, 600);
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, [1]);
  // 跳完之後重新開始：下一個 1 一樣要等
  harness.press('1');
  assert.deepEqual(harness.jumps, [1]);
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, [1, 1]);
});

test('a second digit inside the wait completes a two-digit number and jumps without waiting', () => {
  const harness = createTabNumberHarness(14);
  harness.press('12');
  assert.deepEqual(harness.jumps, [12]);
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, [12]);
  harness.press('10');
  assert.deepEqual(harness.jumps, [12, 10]);
  // 120 個 tab：12 還可能是 120，要再等；第三位數字到了就跳
  const many = createTabNumberHarness(120);
  many.press('12');
  assert.deepEqual(many.jumps, []);
  many.press('0');
  assert.deepEqual(many.jumps, [120]);
  many.press('10');
  assert.deepEqual(many.jumps, [120]);
  many.timers.runAll();
  assert.deepEqual(many.jumps, [120, 10]);
});

test('a leading zero or an out-of-range number is ignored and clears the input', () => {
  const harness = createTabNumberHarness(14);
  harness.press('0');
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, []);
  harness.press('15');
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, []);
  // 15 被丟掉之後，下一個數字重新開始
  harness.press('7');
  assert.deepEqual(harness.jumps, [7]);
  const none = createTabNumberHarness(0);
  none.press('1');
  none.timers.runAll();
  assert.deepEqual(none.jumps, []);
});

test('cancel drops a half-typed number so the next key works as usual', () => {
  const harness = createTabNumberHarness(14);
  harness.press('1');
  harness.input.cancel();
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, []);
  harness.press('1');
  harness.input.dispose();
  harness.timers.runAll();
  assert.deepEqual(harness.jumps, []);
  harness.press('4');
  assert.deepEqual(harness.jumps, [4]);
});
