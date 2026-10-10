import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyScrollKey, createScrollState, resolveScrollView, wheelScrollLines } from '../lib/scroll.mjs';

const viewHeight = 10;

test('a new tab follows the newest lines', () => {
  const state = createScrollState();
  assert.deepEqual(resolveScrollView(state, 50, viewHeight), { start: 40, isFollowing: true, newLineCount: 0 });
  assert.deepEqual(resolveScrollView(state, 3, viewHeight), { start: 0, isFollowing: true, newLineCount: 0 });
});

test('scrolling up pauses follow and keeps the position while new lines arrive', () => {
  const state = createScrollState();
  assert.equal(applyScrollKey(state, 'up', 50, viewHeight), true);
  assert.deepEqual(resolveScrollView(state, 50, viewHeight), { start: 39, isFollowing: false, newLineCount: 0 });
  assert.deepEqual(resolveScrollView(state, 53, viewHeight), { start: 39, isFollowing: false, newLineCount: 3 });
  assert.deepEqual(resolveScrollView(state, 58, viewHeight), { start: 39, isFollowing: false, newLineCount: 8 });
});

test('End resumes follow and clears the new line count', () => {
  const state = createScrollState();
  applyScrollKey(state, 'page-up', 50, viewHeight);
  assert.equal(resolveScrollView(state, 55, viewHeight).newLineCount, 5);
  assert.equal(applyScrollKey(state, 'end', 55, viewHeight), true);
  assert.deepEqual(resolveScrollView(state, 55, viewHeight), { start: 45, isFollowing: true, newLineCount: 0 });
  assert.deepEqual(resolveScrollView(state, 60, viewHeight), { start: 50, isFollowing: true, newLineCount: 0 });
});

test('scrolling back down to the bottom resumes follow', () => {
  const state = createScrollState();
  applyScrollKey(state, 'up', 50, viewHeight);
  applyScrollKey(state, 'up', 50, viewHeight);
  applyScrollKey(state, 'down', 52, viewHeight);
  assert.deepEqual(resolveScrollView(state, 52, viewHeight), { start: 39, isFollowing: false, newLineCount: 2 });
  applyScrollKey(state, 'page-down', 52, viewHeight);
  assert.deepEqual(resolveScrollView(state, 52, viewHeight), { start: 42, isFollowing: true, newLineCount: 0 });
});

test('the top boundary clamps at the oldest line', () => {
  const state = createScrollState();
  applyScrollKey(state, 'home', 50, viewHeight);
  assert.deepEqual(resolveScrollView(state, 50, viewHeight), { start: 0, isFollowing: false, newLineCount: 0 });
  applyScrollKey(state, 'up', 50, viewHeight);
  applyScrollKey(state, 'page-up', 50, viewHeight);
  applyScrollKey(state, 'wheel-up', 50, viewHeight);
  assert.equal(resolveScrollView(state, 50, viewHeight).start, 0);
  applyScrollKey(state, 'end', 50, viewHeight);
  for (let index = 0; index < 10; index += 1) {
    applyScrollKey(state, 'page-up', 50, viewHeight);
  }
  assert.equal(resolveScrollView(state, 50, viewHeight).start, 0);
});

test('the bottom boundary never scrolls past the newest line', () => {
  const state = createScrollState();
  applyScrollKey(state, 'down', 50, viewHeight);
  applyScrollKey(state, 'page-down', 50, viewHeight);
  applyScrollKey(state, 'wheel-down', 50, viewHeight);
  assert.deepEqual(resolveScrollView(state, 50, viewHeight), { start: 40, isFollowing: true, newLineCount: 0 });
});

test('content shorter than one screen never pauses follow', () => {
  const state = createScrollState();
  for (const key of ['up', 'page-up', 'wheel-up', 'home']) {
    applyScrollKey(state, key, 4, viewHeight);
    assert.deepEqual(resolveScrollView(state, 4, viewHeight), { start: 0, isFollowing: true, newLineCount: 0 }, key);
  }
});

test('page keys move one screen and the wheel moves three lines', () => {
  assert.equal(wheelScrollLines, 3);
  const state = createScrollState();
  applyScrollKey(state, 'page-up', 100, viewHeight);
  assert.equal(resolveScrollView(state, 100, viewHeight).start, 80);
  applyScrollKey(state, 'wheel-up', 100, viewHeight);
  assert.equal(resolveScrollView(state, 100, viewHeight).start, 77);
  applyScrollKey(state, 'wheel-down', 100, viewHeight);
  applyScrollKey(state, 'page-down', 100, viewHeight);
  assert.equal(resolveScrollView(state, 100, viewHeight).isFollowing, true);
});

test('a paused view that ends up at the bottom after a resize goes back to follow', () => {
  const state = createScrollState();
  applyScrollKey(state, 'up', 50, viewHeight);
  assert.equal(resolveScrollView(state, 52, viewHeight).isFollowing, false);
  assert.deepEqual(resolveScrollView(state, 52, 20), { start: 32, isFollowing: true, newLineCount: 0 });
});

test('a log that was re-read shorter is clamped instead of showing a blank screen', () => {
  const state = createScrollState();
  applyScrollKey(state, 'page-up', 50, viewHeight);
  applyScrollKey(state, 'page-up', 50, viewHeight);
  assert.equal(resolveScrollView(state, 50, viewHeight).start, 20);
  assert.deepEqual(resolveScrollView(state, 12, viewHeight), { start: 2, isFollowing: true, newLineCount: 0 });
});

test('separate states keep separate positions', () => {
  const first = createScrollState();
  const second = createScrollState();
  applyScrollKey(first, 'home', 50, viewHeight);
  assert.equal(resolveScrollView(first, 50, viewHeight).start, 0);
  assert.deepEqual(resolveScrollView(second, 30, viewHeight), { start: 20, isFollowing: true, newLineCount: 0 });
});

test('keys that do not scroll are reported as not handled', () => {
  const state = createScrollState();
  for (const key of ['left', 'right', 'q', 'other', 'constructor', 'toString']) {
    assert.equal(applyScrollKey(state, key, 50, viewHeight), false, key);
  }
  assert.equal(resolveScrollView(state, 50, viewHeight).isFollowing, true);
});
