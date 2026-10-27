import { sanitizeText } from './text.mjs';
import {
  detectRecordEndSignal,
  extractBackgroundLaunch,
  extractBackgroundSettlement,
  extractRecordEvents,
  parseTimestampMs,
} from './transcript.mjs';

// Bash tool 單次最長可跑 10 分鐘，期間 transcript 不會有新的一行；門檻比它短會把正在等指令的 sub 誤判成結束
export const staleAfterMs = 10 * 60 * 1000;
// 背景工作結束後 sub 被叫醒要一點時間（實測 1–2 秒）；過了還沒回來就當成 sub 已經不在（實測：等待中被停掉的 sub 不會留下任何結束訊號）
export const resumeGraceMs = 30 * 1000;
// main transcript 的 killed／failed 是最終結果；completed 在 sub 暫停等背景工作時也會出現，不能單獨當成結束
const finalEndReasons = new Set(['killed', 'failed']);

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
    // taskId → { taskId, kind: 'shell' | 'agent', outputPath, settledAtMs }：這個 sub 自己啟動的背景工作
    ownTasks: new Map(),
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
  state.ownTasks = new Map();
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

function applyBackgroundTaskRecord(state, record, timestampMs) {
  const launch = extractBackgroundLaunch(record);
  if (launch !== null && !state.ownTasks.has(launch.taskId)) {
    state.ownTasks.set(launch.taskId, { ...launch, settledAtMs: null });
    return true;
  }
  const settledTaskId = extractBackgroundSettlement(record);
  const task = settledTaskId === null ? undefined : state.ownTasks.get(settledTaskId);
  if (task !== undefined && task.settledAtMs === null && timestampMs !== null) {
    task.settledAtMs = timestampMs;
    return true;
  }
  return false;
}

export function applyRecord(state, record) {
  const timestampMs = parseTimestampMs(record?.timestamp);
  let hasChanged = false;
  if (timestampMs !== null && state.startedAtMs === null) {
    state.startedAtMs = timestampMs;
    hasChanged = true;
  }
  if (record?.type !== 'assistant') {
    return applyBackgroundTaskRecord(state, record, timestampMs) || hasChanged;
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
function isNotBeforeActivity(state, timestampMs) {
  return timestampMs !== null && (state.lastActivityMs === null || timestampMs >= state.lastActivityMs);
}

// 這一輪結束了沒：handback、main transcript 的通知、end_turn 都算，背景 sub 也算（只用來判斷要不要看背景工作，不直接當成結束）
function getTurnEndMs(state) {
  const candidates = [state.endSignalMs, state.endTurnMs].filter((value) => value !== null);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

// 自己的背景工作全部結束的時間；有任何一個還沒結束（或判斷不了）就回傳 null
// 結束時間優先用 sub transcript 裡的完成紀錄，沒有的話問 getTaskEndMs（watcher 看輸出檔結尾或巢狀 sub 的狀態）
function getOwnTasksEndMs(state, getTaskEndMs) {
  let latestEndMs = null;
  for (const task of state.ownTasks.values()) {
    const endMs = task.settledAtMs ?? getTaskEndMs(task);
    if (endMs === null || endMs === undefined) {
      return null;
    }
    latestEndMs = latestEndMs === null ? endMs : Math.max(latestEndMs, endMs);
  }
  return latestEndMs;
}

const runningStatus = Object.freeze({ isDone: false, isWaiting: false, reason: null, atMs: null });

// 回傳 { isDone, isWaiting, reason, atMs }，流程見 docs/internals.md 的 when a sub agent counts as finished：
// 1. main transcript 的 killed／failed → 結束
// 2. 這一輪結束了、自己還有背景工作沒結束 → 等待中（handback 也可能在等待前就送出，實測）
// 3. 背景工作都結束了、之後 sub 沒有再跑：resumeGraceMs 內還是等待中，過了就當成結束（等待中被停掉）
// 4. 其他情況照原本規則：handback、通知、非背景 sub 的 end_turn、10 分鐘沒寫入
export function getSubAgentStatus(state, nowMs, { getTaskEndMs = () => null, graceMs = resumeGraceMs } = {}) {
  const endSignal = getEndSignal(state);
  if (endSignal !== null && finalEndReasons.has(endSignal.reason) && isNotBeforeActivity(state, endSignal.atMs)) {
    return { isDone: true, isWaiting: false, reason: endSignal.reason, atMs: endSignal.atMs };
  }
  if (state.ownTasks.size > 0) {
    const turnEndMs = getTurnEndMs(state);
    if (isNotBeforeActivity(state, turnEndMs)) {
      const tasksEndMs = getOwnTasksEndMs(state, getTaskEndMs);
      if (tasksEndMs === null) {
        return { isDone: false, isWaiting: true, reason: null, atMs: turnEndMs };
      }
      if (isNotBeforeActivity(state, tasksEndMs)) {
        return nowMs - tasksEndMs >= graceMs
          ? { isDone: true, isWaiting: false, reason: 'not_resumed', atMs: tasksEndMs }
          : { isDone: false, isWaiting: true, reason: null, atMs: turnEndMs };
      }
      // 背景工作結束之後 sub 又跑過：這一輪的結束照原本規則判斷
    }
  }
  if (endSignal !== null && isNotBeforeActivity(state, endSignal.atMs)) {
    return { isDone: true, isWaiting: false, reason: endSignal.reason, atMs: endSignal.atMs };
  }
  if (state.lastWriteMs !== null && nowMs - state.lastWriteMs > staleAfterMs) {
    return { isDone: true, isWaiting: false, reason: 'stale', atMs: state.lastWriteMs };
  }
  return runningStatus;
}

export function compareSubAgents(left, right) {
  const leftStartMs = left.startedAtMs ?? left.discoveredAtMs;
  const rightStartMs = right.startedAtMs ?? right.discoveredAtMs;
  if (leftStartMs !== rightStartMs) {
    return leftStartMs - rightStartMs;
  }
  return left.agentId.localeCompare(right.agentId);
}
