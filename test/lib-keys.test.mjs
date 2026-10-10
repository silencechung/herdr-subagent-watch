import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeyDecoder } from '../lib/keys.mjs';

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
  const decoder = createKeyDecoder((key) => {
    keys.push(key);
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

test('digits are not special keys', () => {
  assert.deepEqual(decode(['1', '9']), ['other', 'other']);
});

test('an arrow sequence split across chunks is not mistaken for Esc', () => {
  assert.deepEqual(decode(['\x1b', '[C']), ['right']);
  assert.deepEqual(decode(['\x1b[', 'D']), ['left']);
});

test('several keys in one chunk decode in order', () => {
  assert.deepEqual(decode(['\x1b[C\x1b[C1\x1b[Dq']), ['right', 'right', 'other', 'left', 'q']);
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

test('SGR mouse clicks and releases are ignored and never leak characters', () => {
  assert.deepEqual(decode(['\x1b[<0;113;113M', '\x1b[<0;113;113m', '\x1b[<64;1;1m']), ['other', 'other', 'other']);
});

test('an SGR mouse sequence split across chunks still decodes', () => {
  assert.deepEqual(decode(['\x1b[<6', '4;12;', '7M']), ['wheel-up']);
  assert.deepEqual(decode(['\x1b', '[<65;1;1M']), ['wheel-down']);
});

test('X10 mouse reports swallow their raw coordinate bytes', () => {
  // button 64 + 32 = '`'；座標 byte 是 q（113）時不能被當成關閉鍵
  assert.deepEqual(decode(['\x1b[M`qq']), ['wheel-up']);
  assert.deepEqual(decode(['\x1b[Maqq', 'q']), ['wheel-down', 'q']);
  assert.deepEqual(decode(['\x1b[M', '`qq']), ['wheel-up']);
});
