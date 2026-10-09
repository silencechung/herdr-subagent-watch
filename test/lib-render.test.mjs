import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildEventLine,
  buildFrame,
  buildTabBar,
  buildTabLabels,
  emptySessionMessage,
  getVisibleTabRange,
} from '../lib/render.mjs';
import { displayWidth } from '../lib/text.mjs';

function makeTab(label, isDone, events = []) {
  return { label, isDone, events };
}

test('tab bar shows running and done glyphs without any numbers', () => {
  const tabBar = buildTabBar([makeTab('Explore', false), makeTab('general-purpose', true)], 0, 80, false);
  assert.equal(tabBar, '◀ [Explore ●] [general-purpose ✓] ▶');
  assert.doesNotMatch(tabBar, /\d/);
});

test('tab labels add a description snippet only when agent types repeat', () => {
  const labels = buildTabLabels([
    { agentId: 'a1', agentType: 'Explore', description: 'Find things' },
    { agentId: 'a2', agentType: 'general-purpose', description: 'Write README' },
    { agentId: 'a3', agentType: 'general-purpose', description: '刪除空的 secrets.fish 設定檔' },
    { agentId: 'a4abcdef99', agentType: null, description: null },
  ]);
  assert.equal(labels[0], 'Explore');
  assert.equal(labels[1], 'general-purpose: Write README');
  assert.match(labels[2], /^general-purpose: 刪除空的/);
  assert.ok(displayWidth(labels[2]) <= 'general-purpose: '.length + 16);
  assert.equal(labels[3], 'agent');
});

test('visible tab range always contains the selected tab', () => {
  const widths = [10, 10, 10, 10, 10, 10];
  for (let selectedIndex = 0; selectedIndex < widths.length; selectedIndex += 1) {
    const { start, end } = getVisibleTabRange(widths, selectedIndex, 25);
    assert.ok(start <= selectedIndex && selectedIndex <= end);
  }
  assert.deepEqual(getVisibleTabRange(widths, 0, 200), { start: 0, end: 5 });
});

test('narrow tab bar keeps the selected tab visible and fits the width', () => {
  const tabs = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((label) => makeTab(label, false));
  const tabBar = buildTabBar(tabs, 4, 30, false);
  assert.ok(tabBar.includes('[echo ●]'));
  assert.ok(displayWidth(tabBar) <= 30);
});

test('event lines follow HH:MM:SS  tool  summary and fit the width', () => {
  const timestampMs = new Date(2026, 9, 10, 9, 5, 7).getTime();
  const line = buildEventLine({ kind: 'tool', timestampMs, tool: 'Bash', summary: 'git status --short' }, 80, false);
  assert.equal(line, '09:05:07  Bash        git status --short');
  const thinking = buildEventLine({ kind: 'thinking', timestampMs, tool: 'thinking...', summary: '' }, 80, false);
  assert.equal(thinking, '09:05:07  thinking...');
  const wide = buildEventLine({ kind: 'tool', timestampMs, tool: 'Read', summary: '中'.repeat(100) }, 40, false);
  assert.ok(displayWidth(wide) <= 40);
  const end = buildEventLine({ kind: 'end', timestampMs, tool: '', summary: 'done' }, 80, false);
  assert.equal(end, '09:05:07  ── done ──');
});

test('frame without sub agents shows the empty session message', () => {
  const lines = buildFrame({ tabs: [], selectedIndex: 0, width: 60, height: 10, useColor: false, sessionLabel: 'session abc' });
  assert.equal(lines.length, 10);
  assert.equal(lines[2], emptySessionMessage);
  assert.match(lines[8], /session abc/);
});

test('frame scrolls to the newest events when they exceed the body height', () => {
  const events = Array.from({ length: 30 }, (_, index) => ({ kind: 'tool', timestampMs: 0, tool: 'Bash', summary: `step ${index}` }));
  const lines = buildFrame({ tabs: [makeTab('Explore', false, events)], selectedIndex: 0, width: 60, height: 10, useColor: false });
  const body = lines.slice(2, 8);
  assert.equal(body.length, 6);
  assert.match(body[5], /step 29$/);
  assert.match(body[0], /step 24$/);
});

test('footer advertises arrow switching and close keys but no digit jump', () => {
  const lines = buildFrame({ tabs: [makeTab('Explore', false)], selectedIndex: 0, width: 80, height: 8, useColor: false });
  const footer = lines.at(-1);
  assert.match(footer, /<-\/-> switch/);
  assert.match(footer, /q\/Esc close/);
  assert.doesNotMatch(footer, /1-9/);
});
