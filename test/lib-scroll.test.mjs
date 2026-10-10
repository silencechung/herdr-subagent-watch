import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyScrollKey, createRowLayout, createScrollState, locateRow, resolveScrollView, wheelScrollLines } from '../lib/scroll.mjs';

const viewHeight = 10;

// 每個事件一行：行為等同折行前的逐事件捲動
function uniform(eventCount) {
  return createRowLayout(new Array(eventCount).fill(1));
}

test('a new tab follows the newest lines', () => {
  const state = createScrollState();
  assert.deepEqual(resolveScrollView(state, uniform(50), viewHeight), { start: 40, isFollowing: true, newLineCount: 0 });
  assert.deepEqual(resolveScrollView(state, uniform(3), viewHeight), { start: 0, isFollowing: true, newLineCount: 0 });
});

test('scrolling up pauses follow and keeps the position while new lines arrive', () => {
  const state = createScrollState();
  assert.equal(applyScrollKey(state, 'up', uniform(50), viewHeight), true);
  assert.deepEqual(resolveScrollView(state, uniform(50), viewHeight), { start: 39, isFollowing: false, newLineCount: 0 });
  assert.deepEqual(resolveScrollView(state, uniform(53), viewHeight), { start: 39, isFollowing: false, newLineCount: 3 });
  assert.deepEqual(resolveScrollView(state, uniform(58), viewHeight), { start: 39, isFollowing: false, newLineCount: 8 });
});

test('End resumes follow and clears the new line count', () => {
  const state = createScrollState();
  applyScrollKey(state, 'page-up', uniform(50), viewHeight);
  assert.equal(resolveScrollView(state, uniform(55), viewHeight).newLineCount, 5);
  assert.equal(applyScrollKey(state, 'end', uniform(55), viewHeight), true);
  assert.deepEqual(resolveScrollView(state, uniform(55), viewHeight), { start: 45, isFollowing: true, newLineCount: 0 });
  assert.deepEqual(resolveScrollView(state, uniform(60), viewHeight), { start: 50, isFollowing: true, newLineCount: 0 });
});

test('scrolling back down to the bottom resumes follow', () => {
  const state = createScrollState();
  applyScrollKey(state, 'up', uniform(50), viewHeight);
  applyScrollKey(state, 'up', uniform(50), viewHeight);
  applyScrollKey(state, 'down', uniform(52), viewHeight);
  assert.deepEqual(resolveScrollView(state, uniform(52), viewHeight), { start: 39, isFollowing: false, newLineCount: 2 });
  applyScrollKey(state, 'page-down', uniform(52), viewHeight);
  assert.deepEqual(resolveScrollView(state, uniform(52), viewHeight), { start: 42, isFollowing: true, newLineCount: 0 });
});

test('the top boundary clamps at the oldest line', () => {
  const state = createScrollState();
  applyScrollKey(state, 'home', uniform(50), viewHeight);
  assert.deepEqual(resolveScrollView(state, uniform(50), viewHeight), { start: 0, isFollowing: false, newLineCount: 0 });
  applyScrollKey(state, 'up', uniform(50), viewHeight);
  applyScrollKey(state, 'page-up', uniform(50), viewHeight);
  applyScrollKey(state, 'wheel-up', uniform(50), viewHeight);
  assert.equal(resolveScrollView(state, uniform(50), viewHeight).start, 0);
  applyScrollKey(state, 'end', uniform(50), viewHeight);
  for (let index = 0; index < 10; index += 1) {
    applyScrollKey(state, 'page-up', uniform(50), viewHeight);
  }
  assert.equal(resolveScrollView(state, uniform(50), viewHeight).start, 0);
});

test('the bottom boundary never scrolls past the newest line', () => {
  const state = createScrollState();
  applyScrollKey(state, 'down', uniform(50), viewHeight);
  applyScrollKey(state, 'page-down', uniform(50), viewHeight);
  applyScrollKey(state, 'wheel-down', uniform(50), viewHeight);
  assert.deepEqual(resolveScrollView(state, uniform(50), viewHeight), { start: 40, isFollowing: true, newLineCount: 0 });
});

test('content shorter than one screen never pauses follow', () => {
  const state = createScrollState();
  for (const key of ['up', 'page-up', 'wheel-up', 'home']) {
    applyScrollKey(state, key, uniform(4), viewHeight);
    assert.deepEqual(resolveScrollView(state, uniform(4), viewHeight), { start: 0, isFollowing: true, newLineCount: 0 }, key);
  }
});

test('page keys move one screen and the wheel moves three lines', () => {
  assert.equal(wheelScrollLines, 3);
  const state = createScrollState();
  applyScrollKey(state, 'page-up', uniform(100), viewHeight);
  assert.equal(resolveScrollView(state, uniform(100), viewHeight).start, 80);
  applyScrollKey(state, 'wheel-up', uniform(100), viewHeight);
  assert.equal(resolveScrollView(state, uniform(100), viewHeight).start, 77);
  applyScrollKey(state, 'wheel-down', uniform(100), viewHeight);
  applyScrollKey(state, 'page-down', uniform(100), viewHeight);
  assert.equal(resolveScrollView(state, uniform(100), viewHeight).isFollowing, true);
});

test('a paused view that ends up at the bottom after a resize goes back to follow', () => {
  const state = createScrollState();
  applyScrollKey(state, 'up', uniform(50), viewHeight);
  assert.equal(resolveScrollView(state, uniform(52), viewHeight).isFollowing, false);
  assert.deepEqual(resolveScrollView(state, uniform(52), 20), { start: 32, isFollowing: true, newLineCount: 0 });
});

test('a log that was re-read shorter is clamped instead of showing a blank screen', () => {
  const state = createScrollState();
  applyScrollKey(state, 'page-up', uniform(50), viewHeight);
  applyScrollKey(state, 'page-up', uniform(50), viewHeight);
  assert.equal(resolveScrollView(state, uniform(50), viewHeight).start, 20);
  assert.deepEqual(resolveScrollView(state, uniform(12), viewHeight), { start: 2, isFollowing: true, newLineCount: 0 });
});

test('separate states keep separate positions', () => {
  const first = createScrollState();
  const second = createScrollState();
  applyScrollKey(first, 'home', uniform(50), viewHeight);
  assert.equal(resolveScrollView(first, uniform(50), viewHeight).start, 0);
  assert.deepEqual(resolveScrollView(second, uniform(30), viewHeight), { start: 20, isFollowing: true, newLineCount: 0 });
});

test('keys that do not scroll are reported as not handled', () => {
  const state = createScrollState();
  for (const key of ['left', 'right', 'q', 'other', 'constructor', 'toString']) {
    assert.equal(applyScrollKey(state, key, uniform(50), viewHeight), false, key);
  }
  assert.equal(resolveScrollView(state, uniform(50), viewHeight).isFollowing, true);
});

test('locateRow maps a screen row to its event and the row inside that event', () => {
  const layout = createRowLayout([1, 3, 1, 4]);
  assert.equal(layout.totalRows, 9);
  assert.deepEqual(layout.rowStarts, [0, 1, 4, 5, 9]);
  assert.deepEqual(locateRow(layout, 0), { eventIndex: 0, rowOffset: 0 });
  assert.deepEqual(locateRow(layout, 1), { eventIndex: 1, rowOffset: 0 });
  assert.deepEqual(locateRow(layout, 3), { eventIndex: 1, rowOffset: 2 });
  assert.deepEqual(locateRow(layout, 4), { eventIndex: 2, rowOffset: 0 });
  assert.deepEqual(locateRow(layout, 8), { eventIndex: 3, rowOffset: 3 });
  assert.deepEqual(locateRow(layout, 99), { eventIndex: 3, rowOffset: 3 });
  assert.deepEqual(locateRow(layout, -5), { eventIndex: 0, rowOffset: 0 });
  assert.deepEqual(locateRow(createRowLayout([]), 0), { eventIndex: 0, rowOffset: 0 });
});

// 20 個事件，每 4 個有一個折成 3 行：總共 30 行
function mixedRowCounts(eventCount) {
  return Array.from({ length: eventCount }, (_, index) => (index % 4 === 1 ? 3 : 1));
}

test('keys move by wrapped screen rows, not by events', () => {
  const layout = createRowLayout(mixedRowCounts(20));
  assert.equal(layout.totalRows, 30);
  const state = createScrollState();
  assert.deepEqual(resolveScrollView(state, layout, viewHeight), { start: 20, isFollowing: true, newLineCount: 0 });
  applyScrollKey(state, 'up', layout, viewHeight);
  assert.equal(resolveScrollView(state, layout, viewHeight).start, 19);
  // 第 19 行是第 13 個事件（3 行，佔 19–21）的第一行
  assert.deepEqual(state, { isFollowing: false, anchorEventIndex: 13, anchorRowOffset: 0, eventCountAtPause: 20 });
  applyScrollKey(state, 'up', layout, viewHeight);
  assert.deepEqual([state.anchorEventIndex, state.anchorRowOffset], [12, 0]);
  // 第 15 行是第 9 個事件（佔 13–15）的最後一行
  applyScrollKey(state, 'wheel-up', layout, viewHeight);
  assert.equal(resolveScrollView(state, layout, viewHeight).start, 15);
  assert.deepEqual([state.anchorEventIndex, state.anchorRowOffset], [9, 2]);
  applyScrollKey(state, 'page-up', layout, viewHeight);
  assert.equal(resolveScrollView(state, layout, viewHeight).start, 5);
  applyScrollKey(state, 'page-up', layout, viewHeight);
  assert.equal(resolveScrollView(state, layout, viewHeight).start, 0);
  applyScrollKey(state, 'page-down', layout, viewHeight);
  applyScrollKey(state, 'wheel-down', layout, viewHeight);
  assert.equal(resolveScrollView(state, layout, viewHeight).start, 13);
  applyScrollKey(state, 'page-down', layout, viewHeight);
  assert.deepEqual(resolveScrollView(state, layout, viewHeight), { start: 20, isFollowing: true, newLineCount: 0 });
});

test('row boundaries: Home is row 0, the bottom resumes follow, a partly visible event keeps its offset', () => {
  const layout = createRowLayout([5, 5, 5]);
  const state = createScrollState();
  applyScrollKey(state, 'home', layout, viewHeight);
  assert.deepEqual(resolveScrollView(state, layout, viewHeight), { start: 0, isFollowing: false, newLineCount: 0 });
  applyScrollKey(state, 'up', layout, viewHeight);
  assert.equal(resolveScrollView(state, layout, viewHeight).start, 0);
  applyScrollKey(state, 'down', layout, viewHeight);
  applyScrollKey(state, 'down', layout, viewHeight);
  assert.deepEqual([state.anchorEventIndex, state.anchorRowOffset], [0, 2]);
  for (let index = 0; index < 3; index += 1) {
    applyScrollKey(state, 'down', layout, viewHeight);
  }
  assert.equal(resolveScrollView(state, layout, viewHeight).isFollowing, true);
  // 一個事件比一頁還高也只算行數
  const tall = createRowLayout([1, 20]);
  const tallState = createScrollState();
  assert.equal(resolveScrollView(tallState, tall, viewHeight).start, 11);
  applyScrollKey(tallState, 'page-up', tall, viewHeight);
  assert.deepEqual([tallState.anchorEventIndex, tallState.anchorRowOffset], [1, 0]);
});

test('↓ N new counts the screen rows of events that arrived after the pause', () => {
  const state = createScrollState();
  applyScrollKey(state, 'page-up', createRowLayout(mixedRowCounts(20)), viewHeight);
  assert.equal(resolveScrollView(state, createRowLayout(mixedRowCounts(20)), viewHeight).newLineCount, 0);
  assert.equal(resolveScrollView(state, createRowLayout([...mixedRowCounts(20), 4]), viewHeight).newLineCount, 4);
  const view = resolveScrollView(state, createRowLayout([...mixedRowCounts(20), 4, 1, 20]), viewHeight);
  assert.deepEqual(view, { start: 10, isFollowing: false, newLineCount: 25 });
});

test('a resize re-wraps rows but keeps the same event at the top', () => {
  // 寬視窗：每個事件一行；窄視窗：每個事件折成 2 行
  const wide = createRowLayout(new Array(40).fill(1));
  const narrow = createRowLayout(new Array(40).fill(2));
  const state = createScrollState();
  applyScrollKey(state, 'page-up', wide, viewHeight);
  applyScrollKey(state, 'page-up', wide, viewHeight);
  assert.equal(resolveScrollView(state, wide, viewHeight).start, 10);
  assert.equal(locateRow(narrow, resolveScrollView(state, narrow, viewHeight).start).eventIndex, 10);
  assert.equal(resolveScrollView(state, narrow, viewHeight).start, 20);
  applyScrollKey(state, 'down', narrow, viewHeight);
  assert.deepEqual([state.anchorEventIndex, state.anchorRowOffset], [10, 1]);
  // 回到寬視窗，那個事件只剩一行：位置停在事件開頭，不會跳到頂
  assert.equal(resolveScrollView(state, wide, viewHeight).start, 10);
  // new 行數照目前寬度重算
  assert.equal(resolveScrollView(state, createRowLayout([...new Array(40).fill(2), 2]), viewHeight).newLineCount, 2);
  assert.equal(resolveScrollView(state, createRowLayout([...new Array(40).fill(1), 1]), viewHeight).newLineCount, 1);
});
