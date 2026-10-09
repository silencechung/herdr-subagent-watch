import { displayWidth, padEndToWidth, truncateToWidth, truncateWithEllipsis } from './text.mjs';

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  reverse: '\x1b[7m',
  textMuted: '\x1b[38;2;168;168;168m',
  accentText: '\x1b[38;2;177;142;240m',
  cursorHome: '\x1b[H',
  eraseLine: '\x1b[2K',
  eraseScreen: '\x1b[2J',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  enterAlternateScreen: '\x1b[?1049h',
  leaveAlternateScreen: '\x1b[?1049l',
};

export const runningGlyph = '●';
export const doneGlyph = '✓';
export const emptySessionMessage = 'No sub agents yet in this session';

const toolColumnWidth = 10;
const descriptionSnippetWidth = 16;
const tabBarArrowWidth = 2;

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

function formatTab(tab) {
  return `[${tab.label} ${tab.isDone ? doneGlyph : runningGlyph}]`;
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

export function buildTabBar(tabs, selectedIndex, width, useColor) {
  const tabTexts = tabs.map(formatTab);
  const tabWidths = tabTexts.map(displayWidth);
  const availableWidth = Math.max(1, width - tabBarArrowWidth * 2);
  const { start, end } = getVisibleTabRange(tabWidths, selectedIndex, availableWidth);
  const hasHiddenLeft = start > 0;
  const hasHiddenRight = end < tabs.length - 1;
  const segments = [segment('◀ ', hasHiddenLeft ? ansi.accentText : ansi.textMuted)];
  for (let index = start; index <= end; index += 1) {
    const tab = tabs[index];
    if (index > start) {
      segments.push(segment(' '));
    }
    if (index === selectedIndex) {
      segments.push(segment(tabTexts[index], ansi.reverse, ansi.bold));
      continue;
    }
    segments.push(segment(`[${tab.label} `));
    segments.push(segment(tab.isDone ? doneGlyph : runningGlyph, tab.isDone ? ansi.textMuted : ansi.accentText));
    segments.push(segment(']'));
  }
  segments.push(segment(' ▶', hasHiddenRight ? ansi.accentText : ansi.textMuted));
  return composeLine(segments, width, useColor);
}

export function buildSeparator(width, useColor, label = '') {
  if (label === '') {
    return composeLine([segment('─'.repeat(width), ansi.textMuted)], width, useColor);
  }
  const labelText = ` ${label} `;
  const remainingWidth = Math.max(0, width - 2 - displayWidth(labelText));
  return composeLine([
    segment('──', ansi.textMuted),
    segment(labelText, ansi.textMuted),
    segment('─'.repeat(remainingWidth), ansi.textMuted),
  ], width, useColor);
}

export function buildEventLine(event, width, useColor) {
  const clockSegment = segment(`${formatClock(event.timestampMs)}  `, ansi.textMuted);
  if (event.kind === 'end') {
    return composeLine([clockSegment, segment(`── ${event.summary} ──`, ansi.textMuted)], width, useColor);
  }
  if (event.kind === 'thinking') {
    return composeLine([clockSegment, segment(event.tool, ansi.textMuted, ansi.italic)], width, useColor);
  }
  const toolSegment = segment(`${padEndToWidth(event.tool, toolColumnWidth)}  `, ansi.bold);
  return composeLine([clockSegment, toolSegment, segment(event.summary)], width, useColor);
}

function buildMessageLines(messages, width, bodyHeight, useColor) {
  const lines = [];
  messages.forEach((message, index) => {
    const codes = index === 0 ? [] : [ansi.textMuted];
    lines.push(composeLine([segment(message, ...codes)], width, useColor));
  });
  return lines.slice(0, bodyHeight);
}

export function buildBody(tab, width, bodyHeight, useColor) {
  const visibleEvents = bodyHeight > 0 ? tab.events.slice(-bodyHeight) : [];
  return visibleEvents.map((event) => buildEventLine(event, width, useColor));
}

export function buildFooter(width, useColor) {
  return composeLine([
    segment('<-/->', ansi.bold),
    segment(' switch   ', ansi.textMuted),
    segment('q/Esc', ansi.bold),
    segment(' close    ', ansi.textMuted),
    segment(runningGlyph, ansi.accentText),
    segment(' running  ', ansi.textMuted),
    segment(doneGlyph),
    segment(' done', ansi.textMuted),
  ], width, useColor);
}

// tabs：[{ label, isDone, events }]；沒有 tab 時 body 顯示 messages（第一行一般色，其餘淡色）
export function buildFrame({ tabs, selectedIndex, width, height, useColor, sessionLabel = '', messages = [emptySessionMessage] }) {
  const bodyHeight = Math.max(1, height - 4);
  const hasTabs = tabs.length > 0;
  const safeSelectedIndex = hasTabs ? Math.min(Math.max(0, selectedIndex), tabs.length - 1) : 0;
  const bodyLines = hasTabs
    ? buildBody(tabs[safeSelectedIndex], width, bodyHeight, useColor)
    : buildMessageLines(messages, width, bodyHeight, useColor);
  while (bodyLines.length < bodyHeight) {
    bodyLines.push('');
  }
  const lines = [
    hasTabs ? buildTabBar(tabs, safeSelectedIndex, width, useColor) : composeLine([segment('◀ ▶', ansi.textMuted)], width, useColor),
    buildSeparator(width, useColor),
    ...bodyLines,
    buildSeparator(width, useColor, sessionLabel),
    buildFooter(width, useColor),
  ];
  return lines.slice(0, Math.max(1, height));
}
