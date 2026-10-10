import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ansi,
  buildEventLine,
  buildFooter,
  buildFrame,
  buildTabBar,
  buildTabLabels,
  buildTabSummary,
  emptySessionMessage,
  getVisibleTabRange,
} from '../lib/render.mjs';
import { displayWidth } from '../lib/text.mjs';

function makeTab(label, isDone, events = []) {
  return { label, isDone, events };
}

const reverse = '\x1b[7m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const magenta = '\x1b[35m';
const reset = '\x1b[0m';
const truecolorPattern = /38;2;|48;2;/;

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

test('tab bar starts with a running/done summary and puts the glyph before each label', () => {
  const tabs = [
    makeTab('Explore', false),
    makeTab('general-purpose', false),
    makeTab('claude-code-guide', true),
    makeTab('Plan', true),
    makeTab('fork', true),
  ];
  const tabBar = buildTabBar(tabs, 0, 120, false);
  assert.equal(tabBar, '2 running · 3 done │ ◀ [● Explore] [● general-purpose] [✓ claude-code-guide] [✓ Plan] [✓ fork] ▶');
  assert.doesNotMatch(tabBar.split('│')[1], /\d/);
});

test('tab summary counts running and done tabs', () => {
  assert.deepEqual(buildTabSummary([]), { runningText: '0', restText: ' running · 0 done │ ' });
  const summary = buildTabSummary([makeTab('a', true), makeTab('b', false), makeTab('c', true), makeTab('d', false), makeTab('e', true)]);
  assert.equal(summary.runningText + summary.restText, '2 running · 3 done │ ');
});

test('tab order follows the input even when done and running tabs interleave', () => {
  const tabBar = buildTabBar([makeTab('first', true), makeTab('second', false), makeTab('third', true)], 1, 120, false);
  assert.equal(tabBar, '1 running · 2 done │ ◀ [✓ first] [● second] [✓ third] ▶');
});

test('a label wider than the room is truncated but keeps its glyph and brackets', () => {
  const running = buildTabBar([makeTab('general-purpose: Write the README', false)], 0, 40, false);
  assert.equal(running, '1 running · 0 done │ ◀ [● general-pu…] ▶');
  assert.equal(displayWidth(running), 40);
  const done = buildTabBar([makeTab('Explore', false), makeTab('刪除空的 secrets.fish 設定檔', true)], 1, 36, false);
  assert.equal(done, '1 running · 1 done │ ◀ [✓ 刪除空…] ▶');
  assert.equal(displayWidth(done), 36);
});

test('selected tab is reverse video bold whether running or done', () => {
  const tabs = [makeTab('Explore', false), makeTab('general-purpose', true)];
  const runningSelected = buildTabBar(tabs, 0, 80, true);
  assert.ok(runningSelected.includes(`${reverse}${bold}[● Explore]${reset}`));
  assert.ok(runningSelected.includes(`${dim}[✓ general-purpose]${reset}`));
  const doneSelected = buildTabBar(tabs, 1, 80, true);
  assert.ok(doneSelected.includes(`${reverse}${bold}[✓ general-purpose]${reset}`));
  // 跑中 tab 用 terminal 預設字色，只有 ● 是 ANSI magenta
  assert.ok(doneSelected.includes(`${dim}◀ ${reset}[${magenta}●${reset} Explore]`));
  assert.ok(doneSelected.startsWith(`${magenta}1${reset}${dim} running · 1 done │ ${reset}`));
  assert.equal(stripAnsi(doneSelected), buildTabBar(tabs, 1, 80, false));
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

test('narrow tab bar keeps the summary and the selected tab visible and fits the width', () => {
  const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const tabs = labels.map((label, index) => makeTab(label, index % 2 === 0));
  for (let selectedIndex = 0; selectedIndex < tabs.length; selectedIndex += 1) {
    const tabBar = buildTabBar(tabs, selectedIndex, 40, false);
    assert.ok(tabBar.startsWith('2 running · 3 done │ ◀ '), tabBar);
    assert.ok(tabBar.endsWith(' ▶'), tabBar);
    assert.ok(tabBar.includes(` ${labels[selectedIndex]}]`), tabBar);
    assert.ok(displayWidth(tabBar) <= 40, tabBar);
  }
  assert.equal(buildTabBar(tabs, 4, 45, false), '2 running · 3 done │ ◀ [● delta] [✓ echo] ▶');
  const colored = buildTabBar(tabs, 4, 45, true);
  assert.ok(colored.includes(`${magenta}◀ ${reset}`));
  assert.ok(colored.includes(`${dim} ▶${reset}`));
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
  assert.equal(lines[0], '0 running · 0 done │ ◀ ▶');
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

test('footer advertises switching, scrolling, follow and close keys but no digit jump', () => {
  const lines = buildFrame({ tabs: [makeTab('Explore', false)], selectedIndex: 0, width: 80, height: 8, useColor: false });
  const footer = lines.at(-1);
  assert.equal(footer, '<-/-> switch  ↑/↓ PgUp/PgDn scroll  End follow  q close');
  assert.doesNotMatch(footer, /1-9/);
});

test('footer shortens its hints on narrow widths and never overflows', () => {
  assert.equal(buildFooter(50, false), '<-/-> switch  ↑/↓ scroll  End follow  q close');
  assert.equal(buildFooter(30, false), '<-/-> ↑/↓ End q');
  for (const width of [10, 20, 40, 60]) {
    assert.ok(displayWidth(buildFooter(width, false, { isFollowing: false, newLineCount: 12 })) <= width);
  }
});

test('footer puts ↓ N new first while follow is paused', () => {
  const paused = buildFooter(80, false, { start: 3, isFollowing: false, newLineCount: 4 });
  assert.equal(paused, '↓ 4 new  <-/-> switch  ↑/↓ PgUp/PgDn scroll  End follow  q close');
  assert.ok(buildFooter(20, false, { isFollowing: false, newLineCount: 4 }).startsWith('↓ 4 new  '));
  assert.ok(buildFooter(80, true, { isFollowing: false, newLineCount: 0 }).startsWith(`${magenta}${bold}↓ 0 new${reset}`));
  assert.doesNotMatch(buildFooter(80, false, { start: 9, isFollowing: true, newLineCount: 0 }), /new/);
});

test('frame shows the scrolled window of events and the paused footer', () => {
  const events = Array.from({ length: 30 }, (_, index) => ({ kind: 'tool', timestampMs: 0, tool: 'Bash', summary: `step ${index}` }));
  const lines = buildFrame({
    tabs: [makeTab('Explore', false, events)],
    selectedIndex: 0,
    width: 80,
    height: 10,
    useColor: false,
    scrollView: { start: 5, isFollowing: false, newLineCount: 2 },
  });
  const body = lines.slice(2, 8);
  assert.match(body[0], /step 5$/);
  assert.match(body[5], /step 10$/);
  assert.match(lines.at(-1), /^↓ 2 new {2}/);
});

test('colored output only uses theme-following SGR codes, never truecolor', () => {
  for (const value of Object.values(ansi)) {
    assert.doesNotMatch(value, truecolorPattern);
  }
  const timestampMs = new Date(2026, 9, 10, 9, 5, 7).getTime();
  const events = [
    { kind: 'tool', timestampMs, tool: 'Bash', summary: 'ls' },
    { kind: 'thinking', timestampMs, tool: 'thinking...', summary: '' },
    { kind: 'end', timestampMs, tool: '', summary: 'done' },
  ];
  const tabs = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((label, index) => makeTab(label, index % 2 === 0, events));
  const frames = [
    buildFrame({ tabs, selectedIndex: 1, width: 40, height: 12, useColor: true, sessionLabel: 'session abc' }),
    buildFrame({ tabs, selectedIndex: 2, width: 200, height: 12, useColor: true, scrollView: { start: 0, isFollowing: false, newLineCount: 3 } }),
    buildFrame({ tabs: [], selectedIndex: 0, width: 80, height: 8, useColor: true, messages: ['first', 'second'] }),
  ];
  for (const lines of frames) {
    const output = lines.join('\n');
    assert.match(output, /\x1b\[/);
    assert.doesNotMatch(output, truecolorPattern);
  }
});
