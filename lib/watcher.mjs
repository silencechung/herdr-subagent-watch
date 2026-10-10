import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseJsonLine, parseTaskNotifications, splitCompleteLines } from './transcript.mjs';
import {
  applyMeta,
  applyNotification,
  applyRecord,
  compareSubAgents,
  createSubAgentState,
  resetSubAgentRecords,
} from './subagent-state.mjs';

const agentTranscriptPattern = /^agent-(.+)\.jsonl$/;
// 一次只讀這麼多 bytes：開一個幾百 MB 的 transcript 時不會一次配置整段 buffer，解出來的字串也遠低於 V8 的長度上限
export const defaultReadChunkBytes = 8 * 1024 * 1024;
// 單一行超過這個長度就整行丟掉：沒換行的資料一直累積會撐爆記憶體，最後超過 V8 字串上限直接 crash
export const defaultMaximumLineLength = 64 * 1024 * 1024;

export function getSessionPaths(transcriptPath) {
  const sessionDirectory = transcriptPath.replace(/\.jsonl$/, '');
  return {
    sessionId: path.basename(sessionDirectory),
    subagentsDirectory: path.join(sessionDirectory, 'subagents'),
  };
}

function createFileCursor() {
  return { offset: 0, pendingText: '', isSkippingLine: false, decoder: new StringDecoder('utf8') };
}

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// 檔案變小代表被重寫，cursor 歸零從頭再讀
function resetCursorIfTruncated(cursor, size) {
  if (size >= cursor.offset) {
    return false;
  }
  Object.assign(cursor, createFileCursor());
  return true;
}

function decodeLines(cursor, bytes, maximumLineLength) {
  let chunkText;
  try {
    chunkText = cursor.decoder.write(bytes);
  } catch {
    // 丟掉這一塊與還沒湊完的行，從下一個換行重新對齊，不要讓整個 viewer crash
    cursor.decoder = new StringDecoder('utf8');
    cursor.pendingText = '';
    cursor.isSkippingLine = true;
    return [];
  }
  // pendingText 不超過 maximumLineLength、chunkText 不超過一塊，相加一定在字串上限內
  const { lines, pendingText } = splitCompleteLines(cursor.pendingText, chunkText);
  if (cursor.isSkippingLine && lines.length > 0) {
    lines.shift();
    cursor.isSkippingLine = false;
  }
  cursor.pendingText = pendingText;
  if (cursor.pendingText.length > maximumLineLength) {
    cursor.pendingText = '';
    cursor.isSkippingLine = true;
  }
  return lines;
}

// 只讀上次讀到之後新增的 bytes，一次最多 readChunkBytes；每一塊解出的完整行交給 onLines，不把整段檔案留在記憶體
function readNewLines(filePath, cursor, size, onLines, { readChunkBytes, maximumLineLength }) {
  if (size <= cursor.offset) {
    return;
  }
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(filePath, 'r');
  } catch {
    return;
  }
  try {
    const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, size - cursor.offset));
    while (cursor.offset < size) {
      let bytesRead;
      try {
        bytesRead = fs.readSync(fileDescriptor, buffer, 0, Math.min(buffer.length, size - cursor.offset), cursor.offset);
      } catch {
        // 讀到一半檔案被刪或權限改了：已讀的部分照常處理，下一輪從 cursor.offset 繼續
        return;
      }
      if (bytesRead === 0) {
        return;
      }
      cursor.offset += bytesRead;
      const lines = decodeLines(cursor, buffer.subarray(0, bytesRead), maximumLineLength);
      if (lines.length > 0) {
        onLines(lines);
      }
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function createSessionWatcher({
  transcriptPath,
  onChange = () => {},
  pollIntervalMs = 1000,
  now = Date.now,
  readChunkBytes = defaultReadChunkBytes,
  maximumLineLength = defaultMaximumLineLength,
}) {
  const { subagentsDirectory } = getSessionPaths(transcriptPath);
  const readOptions = { readChunkBytes, maximumLineLength };
  const subAgentsById = new Map();
  const cursorsByPath = new Map();
  const metaLoadedIds = new Set();
  const latestNotificationById = new Map();
  let directoryWatcher = null;
  let pollTimer = null;
  let scheduledRefresh = null;
  let isStopped = false;

  function getCursor(filePath) {
    let cursor = cursorsByPath.get(filePath);
    if (cursor === undefined) {
      cursor = createFileCursor();
      cursorsByPath.set(filePath, cursor);
    }
    return cursor;
  }

  function loadMeta(state) {
    if (metaLoadedIds.has(state.agentId)) {
      return false;
    }
    const metaPath = path.join(subagentsDirectory, `agent-${state.agentId}.meta.json`);
    let meta;
    try {
      meta = parseJsonLine(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      return false;
    }
    if (meta === null) {
      return false;
    }
    metaLoadedIds.add(state.agentId);
    return applyMeta(state, meta);
  }

  function refreshSubAgent(agentId, fileName) {
    const filePath = path.join(subagentsDirectory, fileName);
    let hasChanged = false;
    let state = subAgentsById.get(agentId);
    if (state === undefined) {
      state = createSubAgentState({ agentId, transcriptPath: filePath, discoveredAtMs: now() });
      subAgentsById.set(agentId, state);
      hasChanged = true;
    }
    hasChanged = loadMeta(state) || hasChanged;
    const stats = statOrNull(filePath);
    if (stats === null) {
      return hasChanged;
    }
    if (state.lastWriteMs !== stats.mtimeMs) {
      state.lastWriteMs = stats.mtimeMs;
      hasChanged = true;
    }
    const cursor = getCursor(filePath);
    if (resetCursorIfTruncated(cursor, stats.size)) {
      resetSubAgentRecords(state);
      hasChanged = true;
    }
    readNewLines(filePath, cursor, stats.size, (lines) => {
      for (const line of lines) {
        const record = parseJsonLine(line);
        if (record !== null) {
          hasChanged = applyRecord(state, record) || hasChanged;
        }
      }
    }, readOptions);
    const notification = latestNotificationById.get(agentId);
    if (notification !== undefined) {
      hasChanged = applyNotification(state, notification) || hasChanged;
    }
    return hasChanged;
  }

  // main transcript 的 <task-notification> 是背景 sub 被 kill／失敗時唯一的結束訊號
  function refreshMainTranscript() {
    const stats = statOrNull(transcriptPath);
    if (stats === null) {
      return false;
    }
    const cursor = getCursor(transcriptPath);
    resetCursorIfTruncated(cursor, stats.size);
    let hasChanged = false;
    readNewLines(transcriptPath, cursor, stats.size, (lines) => {
      for (const line of lines) {
        for (const notification of parseTaskNotifications(line)) {
          const previous = latestNotificationById.get(notification.agentId);
          if (previous === undefined || (notification.timestampMs ?? 0) >= (previous.timestampMs ?? 0)) {
            latestNotificationById.set(notification.agentId, notification);
          }
          const state = subAgentsById.get(notification.agentId);
          if (state !== undefined) {
            hasChanged = applyNotification(state, notification) || hasChanged;
          }
        }
      }
    }, readOptions);
    return hasChanged;
  }

  function ensureDirectoryWatcher() {
    if (directoryWatcher !== null || isStopped) {
      return;
    }
    try {
      directoryWatcher = fs.watch(subagentsDirectory, { persistent: false }, () => {
        scheduleRefresh();
      });
      directoryWatcher.on('error', () => {
        directoryWatcher?.close();
        directoryWatcher = null;
      });
    } catch {
      // 資料夾還沒建立或 inotify 用完：polling 會接手
      directoryWatcher = null;
    }
  }

  function refresh() {
    if (isStopped) {
      return false;
    }
    let hasChanged = refreshMainTranscript();
    let fileNames = [];
    try {
      fileNames = fs.readdirSync(subagentsDirectory);
      ensureDirectoryWatcher();
    } catch {
      fileNames = [];
    }
    for (const fileName of fileNames) {
      const match = agentTranscriptPattern.exec(fileName);
      if (match === null) {
        continue;
      }
      hasChanged = refreshSubAgent(match[1], fileName) || hasChanged;
    }
    return hasChanged;
  }

  function refreshAndNotify() {
    if (refresh()) {
      onChange();
    }
  }

  function scheduleRefresh() {
    if (scheduledRefresh !== null || isStopped) {
      return;
    }
    scheduledRefresh = setTimeout(() => {
      scheduledRefresh = null;
      refreshAndNotify();
    }, 50);
  }

  return {
    subagentsDirectory,
    refresh,
    start() {
      refresh();
      ensureDirectoryWatcher();
      pollTimer = setInterval(refreshAndNotify, pollIntervalMs);
    },
    stop() {
      isStopped = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (scheduledRefresh !== null) {
        clearTimeout(scheduledRefresh);
        scheduledRefresh = null;
      }
      directoryWatcher?.close();
      directoryWatcher = null;
    },
    getSubAgents() {
      return [...subAgentsById.values()].sort(compareSubAgents);
    },
  };
}
