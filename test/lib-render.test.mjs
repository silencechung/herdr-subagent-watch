import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ansi,
  buildEventLayout,
  buildEventRows,
  buildFooter,
  buildFrame,
  buildTabBar,
  buildTabBarLayout,
  buildTabLabels,
  buildTabSummary,
  describeEndReason,
  emptySessionMessage,
  findTabBarAction,
  getVisibleTabRange,
  measureEventRows,
} from '../lib/render.mjs';
import { applyScrollKey, createScrollState, resolveScrollView } from '../lib/scroll.mjs';
import { displayWidth } from '../lib/text.mjs';
import { buildToolSummary } from '../lib/transcript.mjs';

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

test('tab bar starts with a running/done summary, shows the selected tab in full and only numbers for the others', () => {
  const tabs = [
    makeTab('Explore', false),
    makeTab('general-purpose', false),
    makeTab('claude-code-guide', true),
    makeTab('Plan', true),
    makeTab('fork', true),
  ];
  assert.equal(buildTabBar(tabs, 0, 120, false), '2 running · 3 done │   [1 ● Explore] 2 3 4 5');
  assert.equal(buildTabBar(tabs, 2, 120, false), '2 running · 3 done │   1 2 [3 ✓ claude-code-guide] 4 5');
  // 沒選取的 tab 不帶括號、符號與名稱
  const others = buildTabBar(tabs, 4, 120, false).split('│')[1];
  assert.doesNotMatch(others.replace('[5 ✓ fork]', ''), /[[\]●✓]|Explore|general|claude|Plan/);
});

test('tab summary counts running and done tabs', () => {
  assert.deepEqual(buildTabSummary([]), { runningText: '0', restText: ' running · 0 done │ ' });
  const summary = buildTabSummary([makeTab('a', true), makeTab('b', false), makeTab('c', true), makeTab('d', false), makeTab('e', true)]);
  assert.equal(summary.runningText + summary.restText, '2 running · 3 done │ ');
});

test('a sub agent waiting on its background work shows ◐ and its own count', () => {
  const tabs = [makeTab('Explore', false), { ...makeTab('general-purpose', false), isWaiting: true }, makeTab('Plan', true)];
  assert.equal(buildTabBar(tabs, 1, 120, false), '1 running · 1 waiting · 1 done │   1 [2 ◐ general-purpose] 3');
});

test('tab order follows the input even when done and running tabs interleave', () => {
  const tabBar = buildTabBar([makeTab('first', true), makeTab('second', false), makeTab('third', true)], 1, 120, false);
  assert.equal(tabBar, '1 running · 2 done │   1 [2 ● second] 3');
});

test('a selected label wider than the room is truncated but keeps its number, glyph and brackets', () => {
  const running = buildTabBar([makeTab('general-purpose: Write the README', false)], 0, 40, false);
  assert.equal(running, '1 running · 0 done │   [1 ● general-…]');
  assert.equal(displayWidth(running), 38);
  const done = buildTabBar([makeTab('Explore', false), makeTab('刪除空的 secrets.fish 設定檔', true)], 1, 36, false);
  assert.equal(done, '1 running · 1 done │ ◀ [2 ✓ 刪除…]');
  assert.ok(displayWidth(done) <= 36);
});

test('selected tab is reverse video bold; other tabs are bare numbers, bold when running and dim when done', () => {
  const tabs = [makeTab('Explore', false), makeTab('general-purpose', true), makeTab('Plan', false)];
  const runningSelected = buildTabBar(tabs, 0, 80, true);
  assert.ok(runningSelected.includes(`${reverse}${bold}[1 ● Explore]${reset} ${dim}2${reset} ${bold}3${reset}`), runningSelected);
  const doneSelected = buildTabBar(tabs, 1, 80, true);
  assert.ok(doneSelected.includes(`${bold}1${reset} ${reverse}${bold}[2 ✓ general-purpose]${reset} ${bold}3${reset}`), doneSelected);
  assert.ok(doneSelected.startsWith(`${magenta}2${reset}${dim} running · 1 done │ ${reset}`));
  // 編號只用 bold／dim，不上色
  assert.doesNotMatch(doneSelected.split('│')[1], /\x1b\[3\dm/);
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

test('visible tab range always contains the selected tab and grows on both sides', () => {
  const widths = [10, 10, 10, 10, 10, 10];
  for (let selectedIndex = 0; selectedIndex < widths.length; selectedIndex += 1) {
    const { start, end } = getVisibleTabRange(widths, selectedIndex, 25);
    assert.ok(start <= selectedIndex && selectedIndex <= end);
  }
  assert.deepEqual(getVisibleTabRange(widths, 0, 200), { start: 0, end: 5 });
  assert.deepEqual(getVisibleTabRange([1, 1, 1, 1, 1, 9, 1, 1, 1, 1, 1], 5, 17), { start: 3, end: 7 });
  // 一邊到頭了，剩下的寬度給另一邊
  assert.deepEqual(getVisibleTabRange([9, 1, 1, 1, 1, 1, 1], 0, 15), { start: 0, end: 3 });
});

test('narrow tab bar keeps the summary and the selected tab visible and fits the width', () => {
  const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const tabs = labels.map((label, index) => makeTab(label, index % 2 === 0));
  for (let selectedIndex = 0; selectedIndex < tabs.length; selectedIndex += 1) {
    const tabBar = buildTabBar(tabs, selectedIndex, 34, false);
    assert.ok(tabBar.startsWith('2 running · 3 done │ '), tabBar);
    assert.ok(tabBar.includes(`[${selectedIndex + 1} `), tabBar);
    assert.ok(displayWidth(tabBar) <= 34, tabBar);
  }
  assert.equal(buildTabBar(tabs, 4, 34, false), '2 running · 3 done │ ◀ [5 ✓ ec…]');
  assert.equal(buildTabBar(tabs, 0, 34, false), '2 running · 3 done │   [1 ✓ al…] ▶');
  assert.equal(buildTabBar(tabs, 2, 34, false), '2 running · 3 done │ ◀ [3 ✓ ch…] ▶');
  const colored = buildTabBar(tabs, 2, 34, true);
  assert.ok(colored.includes(`${magenta}◀${reset} `), colored);
  assert.ok(colored.endsWith(` ${magenta}▶${reset}`), colored);
});

test('the arrows appear only on a side with hidden tabs, and the left one leaves a blank so numbers keep their columns', () => {
  const tabs = makeNumberedTabs(14);
  const all = buildTabBar(tabs, 6, 200, false);
  assert.doesNotMatch(all, /[◀▶]/);
  assert.equal(all, '9 running · 5 done │   1 2 3 4 5 6 [7 ✓ agent-7] 8 9 10 11 12 13 14');
  const both = buildTabBar(tabs, 6, 60, false);
  assert.equal(both, '9 running · 5 done │ ◀ 3 4 5 6 [7 ✓ agent-7] 8 9 10 11 12 ▶');
  const rightOnly = buildTabBar(tabs, 0, 40, false);
  assert.equal(rightOnly, '9 running · 5 done │   [1 ✓ agent-1] 2 ▶');
  const leftOnly = buildTabBar(tabs, 13, 40, false);
  assert.equal(leftOnly, '9 running · 5 done │ ◀ [14 ● agent-14]');
  // ◀ 出現與否，摘要後面第一個 tab 都從同一欄開始
  const firstTabColumn = (tabBar) => displayWidth(tabBar.slice(0, tabBar.indexOf('│') + 1)) + 3;
  assert.equal(firstTabColumn(rightOnly), firstTabColumn(leftOnly));
  assert.equal(buildTabBarLayout(tabs, 0, 40, false).regions[0].startColumn, buildTabBarLayout(tabs, 13, 40, false).regions[1].startColumn);
});

// 真實 session 常有 10 個以上的 sub agent：label 帶自己的編號，才看得出畫面上的編號是不是完整清單裡的位置
function makeNumberedTabs(count, label = (number) => `agent-${number}`) {
  return Array.from({ length: count }, (_, index) => makeTab(label(index + 1), index % 3 === 0));
}

function readShownNumbers(tabBar) {
  return [...tabBar.split('│')[1].matchAll(/(?:\[)?(\d+)(?= |\]|$)/g)].map((match) => Number(match[1])).filter((number, index, list) => list.indexOf(number) === index);
}

test('tab numbers are positions in the full list and stay put when the visible range scrolls', () => {
  const tabs = makeNumberedTabs(14);
  for (let selectedIndex = 0; selectedIndex < tabs.length; selectedIndex += 1) {
    const tabBar = buildTabBar(tabs, selectedIndex, 50, false);
    const selectedNumber = selectedIndex + 1;
    assert.ok(tabBar.includes(`[${selectedNumber} ${selectedIndex % 3 === 0 ? '✓' : '●'} agent-${selectedNumber}]`), tabBar);
    const numbers = readShownNumbers(tabBar);
    // 看得到的編號是連續的一段，而且包含選取的那個
    assert.ok(numbers.includes(selectedNumber), tabBar);
    assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => numbers[0] + index), tabBar);
    assert.ok(displayWidth(tabBar) <= 50, tabBar);
  }
  assert.equal(buildTabBar(tabs, 0, 50, false), '9 running · 5 done │   [1 ✓ agent-1] 2 3 4 5 6 7 ▶');
  assert.equal(buildTabBar(tabs, 9, 50, false), '9 running · 5 done │ ◀ 8 9 [10 ✓ agent-10] 11 12 ▶');
});

test('two- and three-digit numbers are shown in full, without zero padding, and fit the width', () => {
  const tabs = makeNumberedTabs(14);
  const twelfth = buildTabBar(tabs, 11, 60, false);
  assert.equal(twelfth, '9 running · 5 done │ ◀ 6 7 8 9 10 11 [12 ● agent-12] 13 14');
  assert.ok(displayWidth(twelfth) <= 60, twelfth);
  const wide = buildTabBar(tabs, 0, 400, false);
  assert.match(wide, / 9 10 11 12 13 14$/);
  assert.doesNotMatch(wide, /\b0\d/);
  const hundred = makeNumberedTabs(120, (number) => `general-purpose: task ${number}`);
  const hundredth = buildTabBar(hundred, 99, 70, false);
  assert.equal(hundredth, '80 running · 40 done │ ◀ 98 99 [100 ✓ general-purpose: task 100] 101 ▶');
  assert.ok(displayWidth(hundredth) <= 70, hundredth);
  assert.match(buildTabBar(hundred, 0, 400, false), / 99 100 101 /);
});

test('a narrow tab bar keeps two- and three-digit numbers and truncates only the label', () => {
  const twelfth = buildTabBar(makeNumberedTabs(14), 11, 36, false);
  assert.equal(twelfth, '9 running · 5 done │ ◀ [12 ● age…] ▶');
  assert.equal(displayWidth(twelfth), 36);
  const hundredth = buildTabBar(makeNumberedTabs(100, (number) => `general-purpose: task ${number}`), 99, 35, false);
  assert.equal(hundredth, '66 running · 34 done │ ◀ [100 ✓ ]');
  assert.ok(displayWidth(hundredth) <= 35, hundredth);
});

test('when even the selected number and glyph do not fit next to the summary, the summary gives way', () => {
  const tabs = makeNumberedTabs(14);
  const tabBar = buildTabBar(tabs, 11, 24, false);
  assert.equal(tabBar, '◀ [12 ● agent-12] 13 ▶');
  assert.ok(displayWidth(tabBar) <= 24);
  for (let width = 10; width <= 80; width += 1) {
    for (const selectedIndex of [0, 6, 13]) {
      const narrow = buildTabBar(tabs, selectedIndex, width, false);
      assert.ok(displayWidth(narrow) <= width, `${width}: ${narrow}`);
      assert.ok(narrow.includes(`[${selectedIndex + 1} `), `${width}: ${narrow}`);
    }
  }
});

test('click regions match the drawn columns, including wide CJK and emoji labels', () => {
  const tabs = [makeTab('Explore', false), makeTab('刪除 🚀 設定檔', true), makeTab('Plan', false)];
  const { text, regions } = buildTabBarLayout(tabs, 1, 80, true);
  const plain = stripAnsi(text);
  assert.equal(plain, '2 running · 1 done │   1 [2 ✓ 刪除 🚀 設定檔] 3');
  const columnOf = (needle) => displayWidth(plain.slice(0, plain.indexOf(needle))) + 1;
  assert.deepEqual(regions, [
    { startColumn: columnOf('1 ['), endColumn: columnOf('1 ['), action: { type: 'tab', index: 0 } },
    { startColumn: columnOf('[2'), endColumn: columnOf('[2') + displayWidth('[2 ✓ 刪除 🚀 設定檔]') - 1, action: { type: 'tab', index: 1 } },
    { startColumn: columnOf('] 3') + 2, endColumn: columnOf('] 3') + 2, action: { type: 'tab', index: 2 } },
  ]);
  // 選取 tab 的最後一欄是 ]，下一欄是空白
  assert.equal(findTabBarAction(regions, regions[1].endColumn)?.index, 1);
  assert.equal(findTabBarAction(regions, regions[1].endColumn + 1), null);
  assert.equal(regions[2].endColumn, displayWidth(plain));
  assert.equal(findTabBarAction(regions, 1), null);
});

test('click regions cover two-digit numbers and the arrows, and never go past the width', () => {
  const tabs = makeNumberedTabs(14);
  const { text, regions } = buildTabBarLayout(tabs, 6, 60, false);
  assert.equal(text, '9 running · 5 done │ ◀ 3 4 5 6 [7 ✓ agent-7] 8 9 10 11 12 ▶');
  const at = (column) => findTabBarAction(regions, column);
  const columnOf = (needle) => displayWidth(text.slice(0, text.indexOf(needle))) + 1;
  assert.deepEqual(at(columnOf('◀')), { type: 'previous' });
  assert.deepEqual(at(columnOf('▶')), { type: 'next' });
  assert.equal(at(columnOf('◀') + 1), null);
  assert.deepEqual(at(columnOf('10')), { type: 'tab', index: 9 });
  assert.deepEqual(at(columnOf('10') + 1), { type: 'tab', index: 9 });
  assert.equal(at(columnOf('10') + 2), null);
  assert.deepEqual(at(columnOf('[7')), { type: 'tab', index: 6 });
  assert.deepEqual(at(columnOf('agent-7]') + 7), { type: 'tab', index: 6 });
  for (const region of regions) {
    assert.ok(region.startColumn <= region.endColumn && region.endColumn <= 60);
  }
  assert.deepEqual(buildTabBarLayout([], 0, 60, false).regions, []);
});

test('event lines follow HH:MM:SS  tool  summary and fit the width', () => {
  const timestampMs = new Date(2026, 9, 10, 9, 5, 7).getTime();
  const line = buildEventRows({ kind: 'tool', timestampMs, tool: 'Bash', summary: 'git status --short' }, 80, false);
  assert.deepEqual(line, ['09:05:07  Bash        git status --short']);
  const thinking = buildEventRows({ kind: 'thinking', timestampMs, tool: 'thinking...', summary: '' }, 80, false);
  assert.deepEqual(thinking, ['09:05:07  thinking...']);
  const wide = buildEventRows({ kind: 'tool', timestampMs, tool: 'Read', summary: '中'.repeat(100) }, 40, false);
  for (const row of wide) {
    assert.ok(displayWidth(row) <= 40, row);
  }
  const end = buildEventRows({ kind: 'end', timestampMs, tool: '', summary: 'done' }, 80, false);
  assert.deepEqual(end, ['09:05:07  ── done ──']);
  assert.deepEqual(buildEventRows({ kind: 'tool', timestampMs, tool: 'Bash', summary: '' }, 80, false), ['09:05:07  Bash']);
});

const clockAt = new Date(2026, 9, 10, 9, 5, 7).getTime();
const summaryIndent = ' '.repeat(22);

function toolEvent(tool, summary, extra = {}) {
  return { kind: 'tool', timestampMs: clockAt, tool, summary, ...extra };
}

test('a long summary wraps and continuation rows line up under the summary column', () => {
  const summary = 'node --test /home/user/projects/watch/test/*.test.mjs --reporter spec';
  const rows = buildEventRows(toolEvent('Bash', summary), 50, false);
  assert.deepEqual(rows, [
    '09:05:07  Bash        node --test /home/user/proje',
    `${summaryIndent}cts/watch/test/*.test.mjs --`,
    `${summaryIndent}reporter spec`,
  ]);
  for (const row of rows) {
    assert.ok(displayWidth(row) <= 50, row);
  }
  // 摘要內容接起來跟原文一樣，沒有被截掉
  assert.equal(rows.map((row) => row.slice(22)).join(''), summary);
  assert.equal(measureEventRows(toolEvent('Bash', summary), 50), 3);
  assert.equal(measureEventRows(toolEvent('Bash', summary), 200), 1);
});

test('multi-line commands keep their line breaks and each line wraps on its own', () => {
  const { summary } = buildToolSummary('Bash', { command: "cat <<'EOF' > notes.md\n# Notes\n\n  - indented item that is quite long\nEOF\n" });
  const rows = buildEventRows(toolEvent('Bash', summary), 50, false);
  assert.deepEqual(rows, [
    "09:05:07  Bash        cat <<'EOF' > notes.md",
    `${summaryIndent}# Notes`,
    '',
    `${summaryIndent}  - indented item that is qu`,
    `${summaryIndent}ite long`,
    `${summaryIndent}EOF`,
  ]);
  assert.equal(measureEventRows(toolEvent('Bash', summary), 50), rows.length);
});

test('wide CJK characters are never split across wrapped rows', () => {
  // 摘要欄 19 欄（奇數）：每行最多放 9 個中文字，第 10 個整個移到下一行
  const rows = buildEventRows(toolEvent('Read', '中文'.repeat(15)), 41, false);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(displayWidth(row) <= 41, row);
    assert.doesNotMatch(row, /\uFFFD/);
  }
  assert.equal(rows[0], '09:05:07  Read        中文中文中文中文中');
  assert.equal(displayWidth(rows[1].slice(22)), 18);
  assert.equal(rows.map((row) => row.slice(22)).join(''), '中文'.repeat(15));
});

test('a tool name wider than the tool column gets its own row and the summary stays aligned', () => {
  const rows = buildEventRows(toolEvent('SubagentHandback', 'report delivered to the caller with details'), 50, false);
  assert.deepEqual(rows, [
    '09:05:07  SubagentHandback',
    `${summaryIndent}report delivered to the call`,
    `${summaryIndent}er with details`,
  ]);
  assert.deepEqual(buildEventRows(toolEvent('SubagentHandback', ''), 50, false), ['09:05:07  SubagentHandback']);
  assert.equal(measureEventRows(toolEvent('SubagentHandback', 'short'), 50), 2);
  const colored = buildEventRows(toolEvent('SubagentHandback', 'short'), 50, true);
  assert.equal(colored[0], `${dim}09:05:07  ${reset}${bold}SubagentHandback${reset}`);
});

test('an event shows at most 20 rows and the last one counts the hidden rows', () => {
  const { summary, omittedLineCount } = buildToolSummary('Bash', { command: Array.from({ length: 30 }, (_, index) => `echo line ${index}`).join('\n') });
  assert.equal(omittedLineCount, 10);
  const event = toolEvent('Bash', summary, { omittedLineCount });
  const rows = buildEventRows(event, 80, false);
  assert.equal(rows.length, 20);
  assert.equal(measureEventRows(event, 80), 20);
  assert.equal(rows[0], '09:05:07  Bash        echo line 0');
  assert.equal(rows[18], `${summaryIndent}echo line 18`);
  assert.equal(rows[19], `${summaryIndent}… (+11 more lines)`);
  const colored = buildEventRows(event, 80, true);
  assert.equal(colored[19], `${summaryIndent}${dim}… (+11 more lines)${reset}`);
  // 一行長摘要折出來超過 20 行也一樣
  const long = buildEventRows(toolEvent('Bash', 'x'.repeat(28 * 30)), 50, false);
  assert.equal(long.length, 20);
  assert.equal(long[19], `${summaryIndent}… (+11 more lines)`);
  // 剛好 20 行不需要提示
  assert.equal(buildEventRows(toolEvent('Bash', 'x'.repeat(28 * 20)), 50, false).at(-1), `${summaryIndent}${'x'.repeat(28)}`);
});

test('a summary cut while it was stored still says how much is hidden', () => {
  const rows = buildEventRows(toolEvent('Bash', 'echo first\necho second', { omittedLineCount: 3 }), 80, false);
  assert.deepEqual(rows, [
    '09:05:07  Bash        echo first',
    `${summaryIndent}echo second`,
    `${summaryIndent}… (+3 more lines)`,
  ]);
});

test('frame without sub agents shows the empty session message', () => {
  const lines = buildFrame({ tabs: [], selectedIndex: 0, width: 60, height: 10, useColor: false, sessionLabel: 'session abc' });
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '0 running · 0 done │ ');
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

test('footer advertises switching by arrows, digits and clicks, plus scrolling, follow and close keys', () => {
  const lines = buildFrame({ tabs: [makeTab('Explore', false)], selectedIndex: 0, width: 80, height: 8, useColor: false });
  const footer = lines.at(-1);
  assert.equal(footer, '<-/-> 0-9 click switch  ↑/↓ PgUp/PgDn scroll  End follow  q close');
});

test('footer shortens its hints on narrow widths and never overflows', () => {
  assert.equal(buildFooter(60, false), '<-/-> 0-9 click switch  ↑/↓ scroll  End follow  q close');
  assert.equal(buildFooter(50, false), '<-/-> 0-9 switch  ↑/↓ scroll  End follow  q close');
  assert.equal(buildFooter(30, false), '<-/-> 0-9 ↑/↓ End q');
  assert.equal(buildFooter(16, false), '<-/-> ↑/↓ End q');
  for (const width of [10, 20, 40, 60]) {
    assert.ok(displayWidth(buildFooter(width, false, { isFollowing: false, newLineCount: 12 })) <= width);
  }
});

test('footer puts ↓ N new first while follow is paused', () => {
  const paused = buildFooter(80, false, { start: 3, isFollowing: false, newLineCount: 4 });
  assert.equal(paused, '↓ 4 new  <-/-> 0-9 click switch  ↑/↓ PgUp/PgDn scroll  End follow  q close');
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

// 每 5 個事件放一個 90 字元的長指令：寬 50 時折成 4 行，寬 120 時 1 行
function wrappedSteps(count) {
  return Array.from({ length: count }, (_, index) => {
    const summary = index % 5 === 0 ? `step ${String(index).padStart(2, '0')} ${'-'.repeat(82)}` : `step ${String(index).padStart(2, '0')}`;
    return { kind: 'tool', timestampMs: 0, tool: 'Bash', summary };
  });
}

test('the body follows the newest wrapped rows and can start in the middle of an event', () => {
  const events = wrappedSteps(30);
  const tab = makeTab('Explore', false, events);
  // height 12 → body 8 行；step 25 折成 4 行，後面 26–29 各 1 行
  const follow = buildFrame({ tabs: [tab], selectedIndex: 0, width: 50, height: 12, useColor: false }).slice(2, 10);
  assert.match(follow[0], /step 25 -+$/);
  assert.match(follow[1], /^ {22}-{28}$/);
  assert.match(follow[3], /^ {22}-{6}$/);
  assert.match(follow[4], /step 26$/);
  assert.match(follow[7], /step 29$/);
  const layout = buildEventLayout(events, 50);
  assert.equal(layout.totalRows, 30 + 6 * 3);
  // 第 1 行是 step 00 的第二行
  const scrolled = buildFrame({
    tabs: [tab],
    selectedIndex: 0,
    width: 50,
    height: 12,
    useColor: false,
    layout,
    scrollView: { start: 1, isFollowing: false, newLineCount: 0 },
  }).slice(2, 10);
  assert.match(scrolled[0], /^ {22}-+$/);
  assert.match(scrolled[2], /^ {22}-{6}$/);
  assert.match(scrolled[3], /step 01$/);
  assert.match(scrolled[7], /step 05 -+$/);
});

test('a resize re-wraps the body and keeps the same event at the top', () => {
  const events = wrappedSteps(30);
  const tab = makeTab('Explore', false, events);
  const state = createScrollState();
  const bodyHeight = 6;
  const narrowLayout = buildEventLayout(events, 50);
  // 48 行、一頁 6 行：最底 42 → 36 → 30 → 24 → 18；第 18 行是 step 10（佔 16–19）的第三行
  for (let index = 0; index < 4; index += 1) {
    applyScrollKey(state, 'page-up', narrowLayout, bodyHeight);
  }
  assert.deepEqual([state.anchorEventIndex, state.anchorRowOffset], [10, 2]);
  const frameAt = (width) => {
    const layout = buildEventLayout(events, width);
    const scrollView = resolveScrollView(state, layout, bodyHeight);
    return buildFrame({ tabs: [tab], selectedIndex: 0, width, height: bodyHeight + 4, useColor: false, layout, scrollView });
  };
  const narrow = frameAt(50);
  assert.match(narrow[2], /^ {22}-{28}$/);
  assert.match(narrow[4], /step 11$/);
  // 變寬後 step 10 只剩一行：停在 step 10，不會跳到頂
  const wide = frameAt(120);
  assert.match(wide[2], /step 10 -{82}$/);
  assert.match(wide[3], /step 11$/);
  assert.match(wide.at(-1), /^↓ 0 new/);
  // 再變窄回到原本那一行
  assert.deepEqual(frameAt(50), narrow);
});

test('the footer counts new wrapped rows while follow is paused', () => {
  const events = wrappedSteps(20);
  const state = createScrollState();
  applyScrollKey(state, 'page-up', buildEventLayout(events, 50), 6);
  // 一個 4 行的長指令 + 一個短指令進來：寬 50 時是 5 行新內容，寬 120 時是 2 行
  events.push({ kind: 'tool', timestampMs: 0, tool: 'Bash', summary: `late ${'-'.repeat(85)}` });
  events.push({ kind: 'tool', timestampMs: 0, tool: 'Bash', summary: 'late short' });
  const narrowView = resolveScrollView(state, buildEventLayout(events, 50), 6);
  assert.equal(narrowView.newLineCount, 5);
  assert.match(buildFooter(80, false, narrowView), /^↓ 5 new {2}/);
  assert.equal(resolveScrollView(state, buildEventLayout(events, 120), 6).newLineCount, 2);
});

test('each end reason has its own end line, and an unknown reason reads done', () => {
  assert.equal(describeEndReason('stale'), 'no writes for 10 min');
  assert.equal(describeEndReason('not_resumed'), 'background work ended, not resumed');
  assert.equal(describeEndReason('waiting_stale'), 'no change for 10 min while waiting');
  assert.equal(describeEndReason('something_new'), 'done');
});
