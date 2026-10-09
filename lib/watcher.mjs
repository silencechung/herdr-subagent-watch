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

export function getSessionPaths(transcriptPath) {
  const sessionDirectory = transcriptPath.replace(/\.jsonl$/, '');
  return {
    sessionId: path.basename(sessionDirectory),
    subagentsDirectory: path.join(sessionDirectory, 'subagents'),
  };
}

function createFileCursor() {
  return { offset: 0, pendingText: '', decoder: new StringDecoder('utf8') };
}

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

// 只讀上次讀到之後新增的 bytes；檔案變小代表被重寫，從頭再讀
function readNewLines(filePath, cursor, size) {
  let wasReset = false;
  if (size < cursor.offset) {
    Object.assign(cursor, createFileCursor());
    wasReset = true;
  }
  if (size === cursor.offset) {
    return { lines: [], wasReset };
  }
  const length = size - cursor.offset;
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  let fileDescriptor = null;
  try {
    fileDescriptor = fs.openSync(filePath, 'r');
    while (bytesRead < length) {
      const count = fs.readSync(fileDescriptor, buffer, bytesRead, length - bytesRead, cursor.offset + bytesRead);
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
  } catch {
    return { lines: [], wasReset };
  } finally {
    if (fileDescriptor !== null) {
      fs.closeSync(fileDescriptor);
    }
  }
  cursor.offset += bytesRead;
  const chunkText = cursor.decoder.write(buffer.subarray(0, bytesRead));
  const { lines, pendingText } = splitCompleteLines(cursor.pendingText, chunkText);
  cursor.pendingText = pendingText;
  return { lines, wasReset };
}

export function createSessionWatcher({ transcriptPath, onChange = () => {}, pollIntervalMs = 1000, now = Date.now }) {
  const { subagentsDirectory } = getSessionPaths(transcriptPath);
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
    const { lines, wasReset } = readNewLines(filePath, getCursor(filePath), stats.size);
    if (wasReset) {
      resetSubAgentRecords(state);
      hasChanged = true;
    }
    for (const line of lines) {
      const record = parseJsonLine(line);
      if (record !== null) {
        hasChanged = applyRecord(state, record) || hasChanged;
      }
    }
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
    const { lines } = readNewLines(transcriptPath, getCursor(transcriptPath), stats.size);
    let hasChanged = false;
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
