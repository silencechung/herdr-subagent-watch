import { displayWidth, sanitizeMultilineText, sanitizeText, truncateToWidth } from './text.mjs';

const summaryFieldByTool = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'pattern',
  WebFetch: 'url',
  Agent: 'description',
};

export const thinkingLabel = 'thinking...';
export const handbackToolName = 'SubagentHandback';

// 實測 main transcript 只出現過這三種；其他狀態不當作結束，交給 stale 備案
const terminalNotificationStatuses = new Set(['completed', 'killed', 'failed']);
const notificationOpenTag = '<task-notification>';
const notificationCloseTag = '</task-notification>';
// 不要改回一個 regex 從 task-id 用 [\s\S]*? 掃到 status：很多 <task-id> 卻沒有 <status> 的長行會變成二次方（1MB 一行要 5 秒）
const taskIdPattern = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/;
const statusPattern = /<status>([a-z_]+)<\/status>/;

export function splitCompleteLines(pendingText, chunkText) {
  const combined = pendingText + chunkText;
  const lines = combined.split('\n');
  const remainder = lines.pop() ?? '';
  return { lines, pendingText: remainder };
}

export function parseJsonLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const value = JSON.parse(trimmed);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function parseTimestampMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const timestampMs = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

// viewer 一個事件最多畫這麼多個畫面行（超過的最後一行改成 `… (+N more lines)`）
export const maximumEventRows = 20;

// 事件整份留給 viewer 捲動、不限筆數，摘要只留夠畫滿 maximumEventRows 行的量，不然 heredoc 很長的 Bash 指令會讓記憶體一直長：
// 最多 maximumEventRows 個邏輯行，總寬度最多 maximumEventRows × 400 欄；摘要欄比 400 欄寬時，單一超長行可能不到 20 行就被截
const widestSummaryColumn = 400;
const maximumSummaryWidth = maximumEventRows * widestSummaryColumn;

// omittedLineCount：沒留下來的邏輯行數，被截一半的那行也算一行；viewer 把它加進 +N
function toBoundedSummary(value) {
  const text = sanitizeMultilineText(value);
  if (text === '') {
    return { summary: '', omittedLineCount: 0 };
  }
  const lines = text.split('\n');
  const keptLines = [];
  let remainingWidth = maximumSummaryWidth;
  for (let index = 0; index < lines.length; index += 1) {
    if (keptLines.length >= maximumEventRows || remainingWidth <= 0) {
      return { summary: keptLines.join('\n'), omittedLineCount: lines.length - index };
    }
    const lineWidth = displayWidth(lines[index]);
    if (lineWidth > remainingWidth) {
      keptLines.push(truncateToWidth(lines[index], remainingWidth).text);
      return { summary: keptLines.join('\n'), omittedLineCount: lines.length - index };
    }
    keptLines.push(lines[index]);
    remainingWidth -= lineWidth;
  }
  return { summary: keptLines.join('\n'), omittedLineCount: 0 };
}

function pickSummarySource(toolName, input) {
  if (input === null || typeof input !== 'object') {
    return typeof input === 'string' ? input : '';
  }
  const preferredField = summaryFieldByTool[toolName];
  if (preferredField !== undefined && typeof input[preferredField] === 'string') {
    return input[preferredField];
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return '';
}

export function buildToolSummary(toolName, input) {
  return toBoundedSummary(pickSummarySource(toolName, input));
}

export function summarizeToolInput(toolName, input) {
  return buildToolSummary(toolName, input).summary;
}

function getContentParts(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

export function extractRecordEvents(record) {
  if (record?.type !== 'assistant') {
    return [];
  }
  const timestampMs = parseTimestampMs(record.timestamp);
  const events = [];
  for (const part of getContentParts(record)) {
    if (part === null || typeof part !== 'object') {
      continue;
    }
    if (part.type === 'tool_use') {
      const toolName = typeof part.name === 'string' && part.name !== '' ? part.name : 'tool';
      const { summary, omittedLineCount } = buildToolSummary(toolName, part.input);
      events.push({
        kind: 'tool',
        toolUseId: typeof part.id === 'string' ? part.id : null,
        timestampMs,
        tool: sanitizeText(toolName),
        summary,
        omittedLineCount,
      });
      continue;
    }
    if (part.type === 'thinking' || part.type === 'redacted_thinking') {
      events.push({ kind: 'thinking', toolUseId: null, timestampMs, tool: thinkingLabel, summary: '' });
    }
  }
  return events;
}

export function detectRecordEndSignal(record) {
  if (record?.type !== 'assistant') {
    return null;
  }
  const hasHandback = getContentParts(record).some((part) => {
    return part?.type === 'tool_use' && part.name === handbackToolName;
  });
  if (hasHandback) {
    return 'handback';
  }
  // fork 類 sub 沒有 SubagentHandback，最後一筆是 stop_reason end_turn 的純文字回覆（實測 31 筆）
  // background sub 中途也會出現 end_turn，算不算結束由 subagent-state.mjs 依 meta 決定
  if (record.message?.stop_reason === 'end_turn') {
    return 'end_turn';
  }
  return null;
}

// 實測 main transcript：每個 task-notification 都會以 queue-operation（enqueue／remove）寫一行，content 以 <task-notification> 開頭、一行一則；
// 改以 user 訊息送達的 60 則全部也有對應的 queue-operation。其他行裡出現的 tag 都不是通知：
// 使用者排隊的訊息同樣是 queue-operation，但 tag 夾在中間（貼上的程式碼、review prompt），user 訊息與 tool_result 可能整段引用，不能拿來判斷結束
export function parseTaskNotifications(line) {
  if (!line.includes(notificationOpenTag) || !line.includes('"queue-operation"')) {
    return [];
  }
  const record = parseJsonLine(line);
  if (record?.type !== 'queue-operation' || typeof record.content !== 'string' || !record.content.startsWith(notificationOpenTag)) {
    return [];
  }
  const closeIndex = record.content.indexOf(notificationCloseTag);
  const body = closeIndex === -1 ? record.content : record.content.slice(0, closeIndex);
  // 只取第一個 task-id 與 status：<summary> 排在後面，裡面是 sub 的 description，可能夾著假的 tag
  const agentId = taskIdPattern.exec(body)?.[1];
  const status = statusPattern.exec(body)?.[1];
  if (agentId === undefined || !terminalNotificationStatuses.has(status)) {
    return [];
  }
  return [{ agentId, status, timestampMs: parseTimestampMs(record.timestamp) }];
}
