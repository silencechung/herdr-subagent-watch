import { detectRecordEndSignal, extractRecordEvents, parseTimestampMs } from './transcript.mjs';

// Bash tool 單次最長可跑 10 分鐘，期間 transcript 不會有新的一行；門檻比它短會把正在等指令的 sub 誤判成結束
export const staleAfterMs = 10 * 60 * 1000;

export function createSubAgentState({ agentId, transcriptPath = null, discoveredAtMs = Date.now() }) {
  return {
    agentId,
    transcriptPath,
    agentType: null,
    description: null,
    discoveredAtMs,
    startedAtMs: null,
    lastActivityMs: null,
    lastWriteMs: null,
    endSignalMs: null,
    endReason: null,
    events: [],
    seenToolUseIds: new Set(),
  };
}

export function resetSubAgentRecords(state) {
  state.startedAtMs = null;
  state.lastActivityMs = null;
  state.endSignalMs = null;
  state.endReason = null;
  state.events = [];
  state.seenToolUseIds = new Set();
}

export function applyMeta(state, meta) {
  if (meta === null || typeof meta !== 'object') {
    return false;
  }
  let hasChanged = false;
  if (typeof meta.agentType === 'string' && meta.agentType !== state.agentType) {
    state.agentType = meta.agentType;
    hasChanged = true;
  }
  if (typeof meta.description === 'string' && meta.description !== state.description) {
    state.description = meta.description;
    hasChanged = true;
  }
  return hasChanged;
}

function setEndSignal(state, timestampMs, reason) {
  if (timestampMs === null) {
    return false;
  }
  if (state.endSignalMs !== null && timestampMs < state.endSignalMs) {
    return false;
  }
  state.endSignalMs = timestampMs;
  state.endReason = reason;
  return true;
}

export function applyRecord(state, record) {
  const timestampMs = parseTimestampMs(record?.timestamp);
  let hasChanged = false;
  if (timestampMs !== null && state.startedAtMs === null) {
    state.startedAtMs = timestampMs;
    hasChanged = true;
  }
  if (record?.type !== 'assistant') {
    return hasChanged;
  }
  if (timestampMs !== null && (state.lastActivityMs === null || timestampMs > state.lastActivityMs)) {
    state.lastActivityMs = timestampMs;
    hasChanged = true;
  }
  for (const event of extractRecordEvents(record)) {
    if (event.toolUseId !== null) {
      if (state.seenToolUseIds.has(event.toolUseId)) {
        continue;
      }
      state.seenToolUseIds.add(event.toolUseId);
    }
    state.events.push(event);
    hasChanged = true;
  }
  const endReason = detectRecordEndSignal(record);
  if (endReason !== null) {
    hasChanged = setEndSignal(state, timestampMs, endReason) || hasChanged;
  }
  return hasChanged;
}

export function applyNotification(state, notification) {
  return setEndSignal(state, notification.timestampMs, notification.status);
}

// 結束訊號要比最後一筆 assistant 活動晚（或同一筆）才算數：sub 被 resume 後會再寫新的 assistant 行，狀態要回到跑中
export function getSubAgentStatus(state, nowMs) {
  if (state.endSignalMs !== null && (state.lastActivityMs === null || state.endSignalMs >= state.lastActivityMs)) {
    return { isDone: true, reason: state.endReason, atMs: state.endSignalMs };
  }
  if (state.lastWriteMs !== null && nowMs - state.lastWriteMs > staleAfterMs) {
    return { isDone: true, reason: 'stale', atMs: state.lastWriteMs };
  }
  return { isDone: false, reason: null, atMs: null };
}

export function compareSubAgents(left, right) {
  const leftStartMs = left.startedAtMs ?? left.discoveredAtMs;
  const rightStartMs = right.startedAtMs ?? right.discoveredAtMs;
  if (leftStartMs !== rightStartMs) {
    return leftStartMs - rightStartMs;
  }
  return left.agentId.localeCompare(right.agentId);
}
