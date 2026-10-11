import { createRowLayout, locateRow } from './scroll.mjs';
import { displayWidth, padEndToWidth, truncateToWidth, truncateWithEllipsis, wrapToWidth } from './text.mjs';
import { maximumEventRows } from './transcript.mjs';

// 只用 SGR 屬性與 ANSI 16 色：顏色交給 terminal theme，不寫死 truecolor 色碼
export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  reverse: '\x1b[7m',
  magenta: '\x1b[35m',
  cursorHome: '\x1b[H',
  eraseLine: '\x1b[2K',
  eraseScreen: '\x1b[2J',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  enterAlternateScreen: '\x1b[?1049h',
  leaveAlternateScreen: '\x1b[?1049l',
  enableMouse: '\x1b[?1000h\x1b[?1006h',
  disableMouse: '\x1b[?1000l\x1b[?1006l',
};

export const runningGlyph = '●';
export const doneGlyph = '✓';
export const emptySessionMessage = 'No sub agents yet in this session';

const clockColumnWidth = displayWidth('00:00:00  ');
const toolColumnWidth = 10;
const toolGapWidth = 2;
const summaryColumnStart = clockColumnWidth + toolColumnWidth + toolGapWidth;
const descriptionSnippetWidth = 16;
const tabBarArrowWidth = displayWidth('◀ ');
const tabGapWidth = 1;

const endNotesByReason = {
  handback: 'done',
  end_turn: 'done',
  completed: 'done',
  killed: 'killed',
  failed: 'failed',
  stale: 'no writes for 10 min',
};

export function segment(text, ...codes) {
  return { text, codes };
}

// 畫面上每一行都經過這裡：segment 文字可能來自 transcript、meta、herdr，truncateToWidth 會剝掉所有 ESC 序列與控制字元
// 輸出裡的 escape 只能是 codes 帶進來的 SGR，不要在這之後再把外來字串接進行裡
// spans[i] 是第 i 個 segment 實際畫在哪幾欄（1-based、截斷後的寬度）：滑鼠點擊的座標要對得上真的畫出來的位置
function composeLineWithSpans(segments, width, useColor) {
  let output = '';
  let usedWidth = 0;
  const spans = [];
  for (const { text, codes } of segments) {
    if (usedWidth >= width) {
      spans.push({ startColumn: usedWidth + 1, width: 0 });
      continue;
    }
    const truncated = truncateToWidth(text, width - usedWidth);
    spans.push({ startColumn: usedWidth + 1, width: truncated.width });
    usedWidth += truncated.width;
    if (useColor && codes.length > 0 && truncated.text !== '') {
      output += codes.join('') + truncated.text + ansi.reset;
    } else {
      output += truncated.text;
    }
  }
  return { text: output, spans };
}

export function composeLine(segments, width, useColor) {
  return composeLineWithSpans(segments, width, useColor).text;
}

export function formatClock(timestampMs) {
  if (timestampMs === null || timestampMs === undefined) {
    return '--:--:--';
  }
  const date = new Date(timestampMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function describeEndReason(reason) {
  return endNotesByReason[reason] ?? 'done';
}

// 同一個 agentType 出現多次時，tab 名稱後面接 description 片段才分得出來
export function buildTabLabels(subAgents) {
  const countsByType = new Map();
  for (const subAgent of subAgents) {
    const agentType = subAgent.agentType ?? 'agent';
    countsByType.set(agentType, (countsByType.get(agentType) ?? 0) + 1);
  }
  return subAgents.map((subAgent) => {
    const agentType = subAgent.agentType ?? 'agent';
    if (countsByType.get(agentType) === 1) {
      return agentType;
    }
    const description = (subAgent.description ?? '').trim();
    const snippet = description === ''
      ? subAgent.agentId.slice(0, 7)
      : truncateWithEllipsis(description, descriptionSnippetWidth);
    return `${agentType}: ${snippet}`;
  });
}

function getTabGlyph(tab) {
  return tab.isDone ? doneGlyph : runningGlyph;
}

function formatSelectedTab(tab, number, label) {
  return `[${number} ${getTabGlyph(tab)} ${label}]`;
}

export function buildTabSummary(tabs) {
  const runningCount = tabs.filter((tab) => !tab.isDone).length;
  return {
    runningText: String(runningCount),
    restText: ` running · ${tabs.length - runningCount} done │ `,
  };
}

// 視窗太窄放不下全部 tab 時，從選取的 tab 開始左右輪流往外加到放不下為止：選取的永遠看得到，兩邊的鄰居也都看得到、點得到
// 某一邊放不下就停掉那一邊，另一邊繼續補，剩下的寬度不浪費
export function getVisibleTabRange(tabWidths, selectedIndex, availableWidth) {
  if (tabWidths.length === 0) {
    return { start: 0, end: -1 };
  }
  let start = selectedIndex;
  let end = selectedIndex;
  let usedWidth = tabWidths[selectedIndex];
  let canGrowRight = true;
  let canGrowLeft = true;
  let isRightTurn = true;
  while (canGrowRight || canGrowLeft) {
    if (isRightTurn && canGrowRight) {
      if (end + 1 < tabWidths.length && usedWidth + tabGapWidth + tabWidths[end + 1] <= availableWidth) {
        end += 1;
        usedWidth += tabGapWidth + tabWidths[end];
      } else {
        canGrowRight = false;
      }
    } else if (!isRightTurn && canGrowLeft) {
      if (start > 0 && usedWidth + tabGapWidth + tabWidths[start - 1] <= availableWidth) {
        start -= 1;
        usedWidth += tabGapWidth + tabWidths[start];
      } else {
        canGrowLeft = false;
      }
    }
    isRightTurn = !isRightTurn;
  }
  return { start, end };
}

// 選取的 tab 顯示完整的 `[編號 符號 名稱]`，其他 tab 只有編號：跑中 bold、結束 dim，只用屬性不上色，跟著 terminal theme
function buildTabSegment(tab, number, label, isSelected) {
  if (isSelected) {
    return segment(formatSelectedTab(tab, number, label), ansi.reverse, ansi.bold);
  }
  return segment(String(number), tab.isDone ? ansi.dim : ansi.bold);
}

// 回傳 { text, regions }：regions 是 tab 列上每個可點區域 { startColumn, endColumn, action }（1-based、含兩端，和 SGR mouse 座標同一套）
// action：{ type: 'tab', index }、{ type: 'previous' }、{ type: 'next' }；欄位範圍取自 composeLine 實際畫出的寬度
export function buildTabBarLayout(tabs, selectedIndex, width, useColor) {
  const { runningText, restText } = buildTabSummary(tabs);
  let segments = [segment(runningText, ansi.magenta), segment(restText, ansi.dim)];
  if (tabs.length === 0) {
    return { text: composeLine(segments, width, useColor), regions: [] };
  }
  const selectedTab = tabs[selectedIndex];
  const selectedFrameWidth = displayWidth(formatSelectedTab(selectedTab, selectedIndex + 1, ''));
  let summaryWidth = displayWidth(runningText + restText);
  // 窄到連選取 tab 的編號和符號都放不下時，摘要讓位：選取的 tab 是唯一一定要看得到的東西
  if (summaryWidth + tabBarArrowWidth * 2 + selectedFrameWidth > width) {
    segments = [];
    summaryWidth = 0;
  }
  // 兩邊箭頭的位置一律先留著：算可見範圍時還不知道會不會有被藏起來的 tab
  const availableWidth = Math.max(0, width - summaryWidth - tabBarArrowWidth * 2);
  const selectedLabel = truncateWithEllipsis(selectedTab.label, Math.max(0, availableWidth - selectedFrameWidth));
  // 編號是 tab 在完整清單裡的位置（從 1 起），可見範圍捲動後也不變，和數字鍵跳轉用的是同一個編號
  const tabWidths = tabs.map((tab, index) => (
    index === selectedIndex ? selectedFrameWidth + displayWidth(selectedLabel) : displayWidth(String(index + 1))
  ));
  const { start, end } = getVisibleTabRange(tabWidths, selectedIndex, availableWidth);
  const actions = segments.map(() => null);
  function push(nextSegment, action = null) {
    segments.push(nextSegment);
    actions.push(action);
  }
  // 左邊沒有藏起來的 tab 時畫成空白而不是不畫：◀ 出現或消失時，後面每個編號的位置都不動，點過的地方不會跑掉
  // 右邊在行尾，空白和不畫看起來一樣，就不輸出尾端空白
  if (start > 0) {
    push(segment('◀', ansi.magenta), { type: 'previous' });
    push(segment(' '));
  } else {
    push(segment(' '.repeat(tabBarArrowWidth)));
  }
  for (let index = start; index <= end; index += 1) {
    if (index > start) {
      push(segment(' '.repeat(tabGapWidth)));
    }
    push(buildTabSegment(tabs[index], index + 1, selectedLabel, index === selectedIndex), { type: 'tab', index });
  }
  if (end < tabs.length - 1) {
    push(segment(' '));
    push(segment('▶', ansi.magenta), { type: 'next' });
  }
  const { text, spans } = composeLineWithSpans(segments, width, useColor);
  const regions = [];
  actions.forEach((action, index) => {
    if (action !== null && spans[index].width > 0) {
      regions.push({ startColumn: spans[index].startColumn, endColumn: spans[index].startColumn + spans[index].width - 1, action });
    }
  });
  return { text, regions };
}

export function buildTabBar(tabs, selectedIndex, width, useColor) {
  return buildTabBarLayout(tabs, selectedIndex, width, useColor).text;
}

// column 是滑鼠點擊的欄（1-based）；沒點到可點區域回傳 null
export function findTabBarAction(regions, column) {
  return regions.find((region) => region.startColumn <= column && column <= region.endColumn)?.action ?? null;
}

export function buildSeparator(width, useColor, label = '') {
  if (label === '') {
    return composeLine([segment('─'.repeat(width), ansi.dim)], width, useColor);
  }
  const labelText = ` ${label} `;
  const remainingWidth = Math.max(0, width - 2 - displayWidth(labelText));
  return composeLine([
    segment('──', ansi.dim),
    segment(labelText, ansi.dim),
    segment('─'.repeat(remainingWidth), ansi.dim),
  ], width, useColor);
}

function wrapSummaryLines(summary, columnWidth, maximumRows) {
  const rows = [];
  let rowCount = 0;
  if (summary === '') {
    return { rows, rowCount };
  }
  for (const line of summary.split('\n')) {
    const wrapped = wrapToWidth(line, columnWidth, Math.max(0, maximumRows - rows.length));
    rows.push(...wrapped.rows);
    rowCount += wrapped.rowCount;
  }
  return { rows, rowCount };
}

// tool 名稱比 tool 欄寬（例 SubagentHandback）時自己佔一行、摘要從下一行開始：所有事件的摘要都對齊同一欄
// 只收 maximumCollectedRows 行字串，行數照算；measure 時傳 0
function planToolEvent(event, width, maximumCollectedRows) {
  const isToolInline = displayWidth(event.tool) <= toolColumnWidth;
  const toolPart = isToolInline
    ? { rows: [event.tool], rowCount: 1 }
    : wrapToWidth(event.tool, Math.max(1, width - clockColumnWidth), maximumCollectedRows);
  const summaryPart = wrapSummaryLines(
    event.summary,
    Math.max(1, width - summaryColumnStart),
    isToolInline ? maximumCollectedRows : maximumCollectedRows - toolPart.rows.length,
  );
  const contentRowCount = isToolInline ? Math.max(1, summaryPart.rowCount) : toolPart.rowCount + summaryPart.rowCount;
  // transcript 存摘要時截掉的部分不在 summary 裡，每個邏輯行至少算一行
  const omittedLineCount = event.omittedLineCount ?? 0;
  const hasMoreRow = omittedLineCount > 0 || contentRowCount > maximumEventRows;
  const shownContentRowCount = hasMoreRow ? Math.min(contentRowCount, maximumEventRows - 1) : contentRowCount;
  return {
    isToolInline,
    toolPart,
    summaryPart,
    shownContentRowCount,
    hasMoreRow,
    moreLineCount: contentRowCount + omittedLineCount - shownContentRowCount,
    rowCount: shownContentRowCount + (hasMoreRow ? 1 : 0),
  };
}

function buildToolContentSegments(event, plan) {
  const clockSegment = segment(`${formatClock(event.timestampMs)}  `, ansi.dim);
  const summaryIndent = segment(' '.repeat(summaryColumnStart));
  const rows = [];
  if (plan.isToolInline) {
    const firstSummaryRow = plan.summaryPart.rows[0] ?? '';
    if (firstSummaryRow === '') {
      rows.push([clockSegment, segment(event.tool, ansi.bold)]);
    } else {
      rows.push([clockSegment, segment(padEndToWidth(event.tool, toolColumnWidth + toolGapWidth), ansi.bold), segment(firstSummaryRow)]);
    }
  } else {
    plan.toolPart.rows.forEach((toolRow, index) => {
      rows.push([index === 0 ? clockSegment : segment(' '.repeat(clockColumnWidth)), segment(toolRow, ansi.bold)]);
    });
  }
  const summaryRows = plan.isToolInline ? plan.summaryPart.rows.slice(1) : plan.summaryPart.rows;
  for (const summaryRow of summaryRows) {
    rows.push(summaryRow === '' ? [] : [summaryIndent, segment(summaryRow)]);
  }
  return rows;
}

// thinking 與 end 固定一行；tool 事件依 width 折行，最多 maximumEventRows 行
export function buildEventRows(event, width, useColor) {
  const clockSegment = segment(`${formatClock(event.timestampMs)}  `, ansi.dim);
  if (event.kind === 'end') {
    return [composeLine([clockSegment, segment(`── ${event.summary} ──`, ansi.dim)], width, useColor)];
  }
  if (event.kind === 'thinking') {
    return [composeLine([clockSegment, segment(event.tool, ansi.dim, ansi.italic)], width, useColor)];
  }
  const plan = planToolEvent(event, width, maximumEventRows);
  const rows = buildToolContentSegments(event, plan)
    .slice(0, plan.shownContentRowCount)
    .map((segments) => composeLine(segments, width, useColor));
  if (plan.hasMoreRow) {
    const moreText = `… (+${plan.moreLineCount} more lines)`;
    rows.push(composeLine([segment(' '.repeat(summaryColumnStart)), segment(moreText, ansi.dim)], width, useColor));
  }
  return rows;
}

// 事件進來後不會再改，行數依 width 快取；長 session 每次重畫只查表，resize 才重算
const rowCountCache = new WeakMap();

export function measureEventRows(event, width) {
  if (event.kind !== 'tool') {
    return 1;
  }
  const cached = rowCountCache.get(event);
  if (cached !== undefined && cached.width === width) {
    return cached.rowCount;
  }
  const { rowCount } = planToolEvent(event, width, 0);
  rowCountCache.set(event, { width, rowCount });
  return rowCount;
}

export function buildEventLayout(events, width) {
  return createRowLayout(events.map((event) => measureEventRows(event, width)));
}

function buildMessageLines(messages, width, bodyHeight, useColor) {
  const lines = [];
  messages.forEach((message, index) => {
    const codes = index === 0 ? [] : [ansi.dim];
    lines.push(composeLine([segment(message, ...codes)], width, useColor));
  });
  return lines.slice(0, bodyHeight);
}

export function getBodyHeight(height) {
  return Math.max(1, height - 4);
}

// start 是畫面行；null 時跟著最新（顯示最後 bodyHeight 行）。只對畫面上看得到的事件組字串
export function buildBody(tab, width, bodyHeight, useColor, start = null, layout = null) {
  if (bodyHeight <= 0 || tab.events.length === 0) {
    return [];
  }
  const eventLayout = layout ?? buildEventLayout(tab.events, width);
  const topRow = start ?? Math.max(0, eventLayout.totalRows - bodyHeight);
  const { eventIndex, rowOffset } = locateRow(eventLayout, topRow);
  const lines = [];
  for (let index = eventIndex; index < tab.events.length && lines.length < bodyHeight; index += 1) {
    const rows = buildEventRows(tab.events[index], width, useColor);
    for (let rowIndex = index === eventIndex ? rowOffset : 0; rowIndex < rows.length && lines.length < bodyHeight; rowIndex += 1) {
      lines.push(rows[rowIndex]);
    }
  }
  return lines;
}

// 由長到短，取第一個放得下的；都放不下就用最短的，超出部分截掉
// 0-9 是輸入 tab 編號直接跳、click 是點 tab 列上的編號或 ◀ ▶；窄的時候先省 click 的說明，數字鍵留到最後
const footerHintVariants = [
  [['<-/-> 0-9 click', ' switch  '], ['↑/↓ PgUp/PgDn', ' scroll  '], ['End', ' follow  '], ['q', ' close']],
  [['<-/-> 0-9 click', ' switch  '], ['↑/↓', ' scroll  '], ['End', ' follow  '], ['q', ' close']],
  [['<-/-> 0-9', ' switch  '], ['↑/↓', ' scroll  '], ['End', ' follow  '], ['q', ' close']],
  [['<-/-> 0-9', ' '], ['↑/↓', ' '], ['End', ' '], ['q', '']],
  [['<-/->', ' '], ['↑/↓', ' '], ['End', ' '], ['q', '']],
];

function measureHints(hints) {
  return displayWidth(hints.map(([keyText, descriptionText]) => keyText + descriptionText).join(''));
}

// scrollView 暫停 follow 時，最前面先放 `↓ N new`，窄視窗也不會被截掉
export function buildFooter(width, useColor, scrollView = null) {
  const segments = [];
  let usedWidth = 0;
  if (scrollView !== null && !scrollView.isFollowing) {
    const newLineText = `↓ ${scrollView.newLineCount} new`;
    segments.push(segment(newLineText, ansi.magenta, ansi.bold), segment('  '));
    usedWidth = displayWidth(newLineText) + 2;
  }
  const hints = footerHintVariants.find((variant) => usedWidth + measureHints(variant) <= width) ?? footerHintVariants.at(-1);
  for (const [keyText, descriptionText] of hints) {
    segments.push(segment(keyText, ansi.bold), segment(descriptionText, ansi.dim));
  }
  return composeLine(segments, width, useColor);
}

// tabs：[{ label, isDone, events }]；沒有 tab 時 body 顯示 messages（第一行一般色，其餘淡色）
// scrollView：選取 tab 的 { start, isFollowing, newLineCount }（見 scroll.mjs）；null 代表跟著最新
// layout：選取 tab 用同一個 width 算好的 buildEventLayout，沒給就自己算
// 回傳 { lines, tabRegions }：tab 列固定是第 1 行，tabRegions 是它的可點區域（見 buildTabBarLayout）
export function buildFrameLayout({ tabs, selectedIndex, width, height, useColor, sessionLabel = '', messages = [emptySessionMessage], scrollView = null, layout = null }) {
  const bodyHeight = getBodyHeight(height);
  const hasTabs = tabs.length > 0;
  const safeSelectedIndex = hasTabs ? Math.min(Math.max(0, selectedIndex), tabs.length - 1) : 0;
  const bodyLines = hasTabs
    ? buildBody(tabs[safeSelectedIndex], width, bodyHeight, useColor, scrollView?.start ?? null, layout)
    : buildMessageLines(messages, width, bodyHeight, useColor);
  while (bodyLines.length < bodyHeight) {
    bodyLines.push('');
  }
  const tabBar = buildTabBarLayout(tabs, safeSelectedIndex, width, useColor);
  const lines = [
    tabBar.text,
    buildSeparator(width, useColor),
    ...bodyLines,
    buildSeparator(width, useColor, sessionLabel),
    buildFooter(width, useColor, hasTabs ? scrollView : null),
  ];
  return { lines: lines.slice(0, Math.max(1, height)), tabRegions: tabBar.regions };
}

export function buildFrame(options) {
  return buildFrameLayout(options).lines;
}
