import { displayWidth, padEndToWidth, truncateToWidth, truncateWithEllipsis } from './text.mjs';

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

const toolColumnWidth = 10;
const descriptionSnippetWidth = 16;
const tabBarArrowWidth = 2;
const tabFrameWidth = displayWidth('[● ]');

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

export function composeLine(segments, width, useColor) {
  let output = '';
  let usedWidth = 0;
  for (const { text, codes } of segments) {
    if (usedWidth >= width) {
      break;
    }
    const truncated = truncateToWidth(text, width - usedWidth);
    usedWidth += truncated.width;
    if (useColor && codes.length > 0 && truncated.text !== '') {
      output += codes.join('') + truncated.text + ansi.reset;
    } else {
      output += truncated.text;
    }
  }
  return output;
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

// 符號放最前面、只截名稱：視窗再窄也看得到每個 tab 是跑中還是結束
function fitTabLabel(tab, maximumWidth) {
  return truncateWithEllipsis(tab.label, Math.max(0, maximumWidth - tabFrameWidth));
}

function formatTab(tab, label) {
  return `[${getTabGlyph(tab)} ${label}]`;
}

export function buildTabSummary(tabs) {
  const runningCount = tabs.filter((tab) => !tab.isDone).length;
  return {
    runningText: String(runningCount),
    restText: ` running · ${tabs.length - runningCount} done │ `,
  };
}

// 視窗太窄放不下全部 tab 時，從選取的 tab 往左吃到放不下為止，再往右補，保證選取的那個永遠看得到
export function getVisibleTabRange(tabWidths, selectedIndex, availableWidth) {
  if (tabWidths.length === 0) {
    return { start: 0, end: -1 };
  }
  const widthOf = (start, end) => {
    let total = 0;
    for (let index = start; index <= end; index += 1) {
      total += tabWidths[index] + (index > start ? 1 : 0);
    }
    return total;
  };
  let start = 0;
  while (start < selectedIndex && widthOf(start, selectedIndex) > availableWidth) {
    start += 1;
  }
  let end = selectedIndex;
  while (end + 1 < tabWidths.length && widthOf(start, end + 1) <= availableWidth) {
    end += 1;
  }
  return { start, end };
}

function buildTabSegments(tab, label, isSelected) {
  if (isSelected) {
    return [segment(formatTab(tab, label), ansi.reverse, ansi.bold)];
  }
  if (tab.isDone) {
    return [segment(formatTab(tab, label), ansi.dim)];
  }
  return [
    segment('['),
    segment(getTabGlyph(tab), ansi.magenta),
    segment(` ${label}]`),
  ];
}

// 摘要先佔位，剩下的寬度才給 tab；單一 tab 比剩下的寬度還寬時截短名稱，選取的 tab 才放得進去
export function buildTabBar(tabs, selectedIndex, width, useColor) {
  const { runningText, restText } = buildTabSummary(tabs);
  const segments = [segment(runningText, ansi.magenta), segment(restText, ansi.dim)];
  if (tabs.length === 0) {
    segments.push(segment('◀ ▶', ansi.dim));
    return composeLine(segments, width, useColor);
  }
  const summaryWidth = displayWidth(runningText + restText);
  const availableWidth = Math.max(1, width - summaryWidth - tabBarArrowWidth * 2);
  const labels = tabs.map((tab) => fitTabLabel(tab, availableWidth));
  const tabWidths = tabs.map((tab, index) => displayWidth(formatTab(tab, labels[index])));
  const { start, end } = getVisibleTabRange(tabWidths, selectedIndex, availableWidth);
  const hasHiddenLeft = start > 0;
  const hasHiddenRight = end < tabs.length - 1;
  segments.push(segment('◀ ', hasHiddenLeft ? ansi.magenta : ansi.dim));
  for (let index = start; index <= end; index += 1) {
    if (index > start) {
      segments.push(segment(' '));
    }
    segments.push(...buildTabSegments(tabs[index], labels[index], index === selectedIndex));
  }
  segments.push(segment(' ▶', hasHiddenRight ? ansi.magenta : ansi.dim));
  return composeLine(segments, width, useColor);
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

export function buildEventLine(event, width, useColor) {
  const clockSegment = segment(`${formatClock(event.timestampMs)}  `, ansi.dim);
  if (event.kind === 'end') {
    return composeLine([clockSegment, segment(`── ${event.summary} ──`, ansi.dim)], width, useColor);
  }
  if (event.kind === 'thinking') {
    return composeLine([clockSegment, segment(event.tool, ansi.dim, ansi.italic)], width, useColor);
  }
  const toolSegment = segment(`${padEndToWidth(event.tool, toolColumnWidth)}  `, ansi.bold);
  return composeLine([clockSegment, toolSegment, segment(event.summary)], width, useColor);
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

// start 是 null 時跟著最新（顯示最後 bodyHeight 行）
export function buildBody(tab, width, bodyHeight, useColor, start = null) {
  if (bodyHeight <= 0) {
    return [];
  }
  const visibleEvents = start === null ? tab.events.slice(-bodyHeight) : tab.events.slice(start, start + bodyHeight);
  return visibleEvents.map((event) => buildEventLine(event, width, useColor));
}

// 由長到短，取第一個放得下的；都放不下就用最短的，超出部分截掉
const footerHintVariants = [
  [['<-/->', ' switch  '], ['↑/↓ PgUp/PgDn', ' scroll  '], ['End', ' follow  '], ['q', ' close']],
  [['<-/->', ' switch  '], ['↑/↓', ' scroll  '], ['End', ' follow  '], ['q', ' close']],
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
export function buildFrame({ tabs, selectedIndex, width, height, useColor, sessionLabel = '', messages = [emptySessionMessage], scrollView = null }) {
  const bodyHeight = getBodyHeight(height);
  const hasTabs = tabs.length > 0;
  const safeSelectedIndex = hasTabs ? Math.min(Math.max(0, selectedIndex), tabs.length - 1) : 0;
  const bodyLines = hasTabs
    ? buildBody(tabs[safeSelectedIndex], width, bodyHeight, useColor, scrollView?.start ?? null)
    : buildMessageLines(messages, width, bodyHeight, useColor);
  while (bodyLines.length < bodyHeight) {
    bodyLines.push('');
  }
  const lines = [
    buildTabBar(tabs, safeSelectedIndex, width, useColor),
    buildSeparator(width, useColor),
    ...bodyLines,
    buildSeparator(width, useColor, sessionLabel),
    buildFooter(width, useColor, hasTabs ? scrollView : null),
  ];
  return lines.slice(0, Math.max(1, height));
}
