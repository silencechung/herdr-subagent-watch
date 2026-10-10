import { sanitizeText } from './text.mjs';
import { detectRecordEndSignal, extractRecordEvents, parseTimestampMs } from './transcript.mjs';

// Bash tool 單次最長可跑 10 分鐘，期間 transcript 不會有新的一行；門檻比它短會把正在等指令的 sub 誤判成結束
export const staleAfterMs = 10 * 60 * 1000;

export function createSubAgentState({ agentId, transcriptPath = null, discoveredAtMs = Date.now() }) {
  return {
    agentId,
    transcriptPath,
    agentType: null,
    description: null,
    isBackground: false,
    discoveredAtMs,
    startedAtMs: null,
    lastActivityMs: null,
    lastWriteMs: null,
    endSignalMs: null,
    endReason: null,
    endTurnMs: null,
    events: [],
    seenToolUseIds: new Set(),
  };
}

export function resetSubAgentRecords(state) {
  state.startedAtMs = null;
  state.lastActivityMs = null;
  state.endSignalMs = null;
  state.endReason = null;
  state.endTurnMs = null;
  state.events = [];
  state.seenToolUseIds = new Set();
}

export function applyMeta(state, meta) {
  if (meta === null || typeof meta !== 'object') {
    return false;
  }
  let hasChanged = false;
  // meta 是別的程式寫的檔案，存進 state 前先拿掉 escape 與控制字元，之後拿來組 tab 名稱才安全
  if (typeof meta.agentType === 'string') {
    const agentType = sanitizeText(meta.agentType) || null;
    if (agentType !== state.agentType) {
      state.agentType = agentType;
      hasChanged = true;
    }
  }
  if (typeof meta.description === 'string') {
    const description = sanitizeText(meta.description);
    if (description !== state.description) {
      state.description = description;
      hasChanged = true;
    }
  }
  // 實測 154 個 meta：122 個一般 sub 是 requestShape background、1 個 foreground；31 個 fork 也是 background，但另有 isFork: true
  // meta 沒有這兩個欄位時當成非 background，end_turn 照舊算結束
  const isBackground = meta.requestShape === 'background' && meta.isFork !== true;
  if (isBackground !== state.isBackground) {
    state.isBackground = isBackground;
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
  if (endReason === 'end_turn') {
    if (timestampMs !== null && (state.endTurnMs === null || timestampMs > state.endTurnMs)) {
      state.endTurnMs = timestampMs;
      hasChanged = true;
    }
  } else if (endReason !== null) {
    hasChanged = setEndSignal(state, timestampMs, endReason) || hasChanged;
  }
  return hasChanged;
}

export function applyNotification(state, notification) {
  return setEndSignal(state, notification.timestampMs, notification.status);
}

// background sub 的 end_turn 只代表這一輪回覆結束：實測 6 個 sub 在 end_turn 後被 [handback-send-enforce] 叫回去補 SubagentHandback，
// 中間約 1–12 秒會被誤判成結束。所以 background sub 只信 SubagentHandback 與 task-notification，end_turn 只給 fork 與前景 sub 用
// isBackground 來自 meta，meta 可能比 transcript 晚讀到，所以每次算狀態時才決定 end_turn 算不算
function getEndSignal(state) {
  const endTurnMs = state.isBackground ? null : state.endTurnMs;
  if (endTurnMs !== null && (state.endSignalMs === null || endTurnMs > state.endSignalMs)) {
    return { atMs: endTurnMs, reason: 'end_turn' };
  }
  if (state.endSignalMs === null) {
    return null;
  }
  return { atMs: state.endSignalMs, reason: state.endReason };
}

// 結束訊號要比最後一筆 assistant 活動晚（或同一筆）才算數：sub 被 resume 後會再寫新的 assistant 行，狀態要回到跑中
export function getSubAgentStatus(state, nowMs) {
  const endSignal = getEndSignal(state);
  if (endSignal !== null && (state.lastActivityMs === null || endSignal.atMs >= state.lastActivityMs)) {
    return { isDone: true, reason: endSignal.reason, atMs: endSignal.atMs };
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
