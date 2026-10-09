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
