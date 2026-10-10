// Claude Code SessionStart／SubagentStart／SubagentStop／Stop／StopFailure hook：更新 herdr 側邊欄 claude 那一列底下的 sub agent 樹狀行（只列跑中的，歷史看 popup viewer），
// 並寫 pane 對照檔給 popup viewer。
// 這是全域 hook，會套用到使用者所有 Claude session：永遠 exit 0、stdout 不輸出、1 秒內結束。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExecutableFile, resolveHerdrBinPath } from '../lib/herdr.mjs';
import { applyMeta, applyNotification, applyRecord, createSubAgentState, getSubAgentStatus } from '../lib/subagent-state.mjs';
import { parseJsonLine, parseTaskNotifications, parseTimestampMs } from '../lib/transcript.mjs';

export const metadataSource = 'subagent.watch';
export const maximumTreeLines = 5;
export const maximumTokenLength = 80;
export const runningIcon = '●';

// Stop 每回合都會觸發，transcript 可能上百 MB：判斷 sub 結束只需要最後幾筆，只讀尾端
export const transcriptTailBytes = 64 * 1024;
// transcript 還不存在的 sub 先留著：SubagentStart 觸發時 sub 可能還沒寫出第一行，超過這段時間仍不存在才當成沒有成功啟動
export const missingTranscriptGraceMs = 2 * 60 * 1000;
// 沒有任何結束訊號、但 transcript 這麼久沒寫：Claude Code 本身被砍掉時 sub 不會留下任何訊號，只能靠時間。
// 門檻取 Bash tool 單次上限（10 分鐘）的 6 倍：sub 等指令、等 API 回應都不會這麼久沒寫入；
// 真的會更久的只有前景 sub 卡在權限確認沒人按，那種情況這一行會被提早拿掉（README 已知限制）
export const abandonedAfterMs = 60 * 60 * 1000;
// 結束訊號比 SubagentStart 早太多，是 resume 之前那一輪留下的；容許一點誤差：hook 的 now() 可能比 sub 的第一筆紀錄晚一點才取
const startClockToleranceMs = 2000;
const maximumMetaBytes = 64 * 1024;
const interruptedMessagePrefix = '[Request interrupted by user';
const sessionEventNames = new Set(['SessionStart', 'Stop', 'StopFailure']);
const subagentEventNames = new Set(['SubagentStart', 'SubagentStop']);
// 官方文件：回合因 API 錯誤結束時不觸發 Stop、改觸發 StopFailure。兩個都只清死掉的 sub 與重畫，不寫對照檔；
// 不接 StopFailure 的話，額度用完的那一回合留下的 sub 要等到這個 session 下一次 hook 事件才拿掉
const pruneOnlyEventNames = new Set(['Stop', 'StopFailure']);
// 官方文件列的 source：startup、resume、clear、compact、fork；認不得的記成 unknown，標記照樣成立
const sessionStartSourcePattern = /^[a-z_]{1,32}$/;

// 加上 node 啟動與 herdr 最低預算後仍要在 1 秒內結束
const totalBudgetMs = 800;
const minimumHerdrBudgetMs = 100;
const maximumPaneQueryMs = 300;
// lock 外判斷 sub 是否結束最多用這麼久，剩下的 sub 留到下一次事件：判斷拖太久的話，這次事件自己的更新反而等不到 lock。
// 實測 5 個 sub、真實大小 transcript：單獨跑約 10 ms，8 個 hook 同時跑最多約 22 ms。8 個擠在 1 個 CPU 上、旁邊還有 4 個吃滿 CPU 的 process 時，
// 每個 hook 都會碰到上限，大家同時判斷、搶 CPU，拿 lock 跟著變慢：上限 200 ms 時 640 次更新掉了 5 次（lock-timeout），100 ms 時 640 次都沒掉
export const maximumPruneMs = 100;
const lockRetryIntervalMs = 10;
// 舊版的 lock 是空檔、沒有 pid 可查，只能看年紀；`.break-*` 檔也用這個年紀判斷是不是被砍掉的 process 留下的
const staleLockMs = 2000;
// hook 整體預算不到 1 秒，超過這個年紀的 lock 不可能還有人在用；pid 查不準時（例如不同 pid namespace）的保險
const maximumLockAgeMs = 10_000;
const maximumAncestorDepth = 64;
const safeIdentifierPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const invisibleCharacterPattern = /[\p{Cc}\p{Cf}]/gu;

export function isSafeIdentifier(value) {
  return typeof value === 'string' && safeIdentifierPattern.test(value) && value !== '.' && value !== '..';
}

// herdr 會移除控制字元並 trim；先做一樣的處理，80 字截斷的長度計算才會跟 herdr 一致。
// \p{Cf}（U+202E 這類 bidi override、U+200B 零寬字元）也拿掉：herdr 文件只說移除控制字元，留著的話 agent_type 能把側邊欄的字反轉或藏起來
export function sanitizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(invisibleCharacterPattern, '').trim();
}

function normalizeSessionStartSource(value) {
  return typeof value === 'string' && sessionStartSourcePattern.test(value) ? value : 'unknown';
}

export function parseHookPayload(rawInput) {
  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const eventName = payload.hook_event_name;
  const isSessionEvent = sessionEventNames.has(eventName);
  if (!isSessionEvent && !subagentEventNames.has(eventName)) {
    return null;
  }
  if (!isSafeIdentifier(payload.session_id)) {
    return null;
  }
  // SessionStart／Stop／StopFailure 是整個 session 的事件，沒有 agent_id；`claude --agent <name>` 的 SessionStart 帶的 agent_type 是主 session 的 agent，不是 sub。
  // StopFailure 的 error 欄位（rate_limit 等）用不到：不管哪種錯誤都一樣檢查
  if (isSessionEvent) {
    return {
      eventName,
      sessionId: payload.session_id,
      agentId: null,
      agentType: null,
      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      source: eventName === 'SessionStart' ? normalizeSessionStartSource(payload.source) : null,
    };
  }
  if (!isSafeIdentifier(payload.agent_id)) {
    return null;
  }
  const agentType = sanitizeText(payload.agent_type);
  // Claude Code 內部 agent（prompt suggestion、/btw）也會觸發 SubagentStop，agent_type 是空字串，不是使用者派的 sub
  if (agentType === '') {
    return null;
  }
  return {
    eventName,
    sessionId: payload.session_id,
    agentId: payload.agent_id,
    agentType,
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
  };
}

export function createEmptySessionState(sessionId) {
  return {
    sessionId,
    lastSequence: 0,
    subagents: [],
  };
}

export function normalizeSessionState(candidate, sessionId) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.subagents)) {
    return createEmptySessionState(sessionId);
  }
  const subagents = candidate.subagents.filter((subagent) => {
    // 舊版狀態檔會留著 status 為 done 的 sub；不丟掉的話升級後它們會被當成跑中
    return subagent && typeof subagent === 'object' && typeof subagent.id === 'string' && subagent.status !== 'done';
  });
  return {
    sessionId,
    lastSequence: Number.isFinite(candidate.lastSequence) ? candidate.lastSequence : 0,
    subagents,
  };
}

// 狀態檔只記跑中的 sub：stop 直接移除，檔案大小只跟同時跑的數量有關
export function applyEvent(state, event, nowMs) {
  if (event.agentId === null) {
    return { changed: false, state };
  }
  const existing = state.subagents.find((subagent) => subagent.id === event.agentId);
  if (event.eventName === 'SubagentStart') {
    // 同一個 sub 還在清單裡又收到 start（例如前一次的 stop 因 lock 逾時沒記到）：只留一筆，保留原本的啟動順序
    const others = state.subagents.filter((subagent) => subagent.id !== event.agentId);
    const started = { id: event.agentId, agentType: event.agentType, startedAtMs: existing?.startedAtMs ?? nowMs };
    return { changed: true, state: { ...state, subagents: [...others, started] } };
  }
  // 沒看過 start 的 stop 不收：可能是內部 agent，或 hook 安裝前就啟動的 sub
  if (!existing) {
    return { changed: false, state };
  }
  const subagents = state.subagents.filter((subagent) => subagent.id !== event.agentId);
  return { changed: true, state: { ...state, subagents } };
}

// 對照檔合約（viewer 讀）：sessionId、transcriptPath、cwd、updatedAtMs 四個欄位不准改；
// sessionStartSource 只在這個 session 的 SessionStart 寫過對照檔時出現，viewer 看到它就信這份對照檔（見 lib/session.mjs）。
// 同一個 session 的 sub 事件重寫時要留著；換成別的 session 就不能帶過去，那個 session 的 SessionStart 不一定有收到
export function buildPaneMap(event, previousPaneMap, nowMs) {
  const paneMap = {
    sessionId: event.sessionId,
    transcriptPath: event.transcriptPath,
    cwd: event.cwd,
    updatedAtMs: nowMs,
  };
  let sessionStartSource = null;
  if (event.eventName === 'SessionStart') {
    sessionStartSource = event.source;
  } else if (previousPaneMap?.sessionId === event.sessionId) {
    sessionStartSource = previousPaneMap.sessionStartSource;
  }
  if (typeof sessionStartSource === 'string' && sessionStartSourcePattern.test(sessionStartSource)) {
    paneMap.sessionStartSource = sessionStartSource;
  }
  return paneMap;
}

// 回傳 { isMissing: true }、{ isMissing: false, text, isTruncated, modifiedMs }，或 null（讀不了，不知道狀況）。
// O_NONBLOCK：路徑上若是 FIFO，一般的 open 會卡住等寫入端，hook 就超過時間預算
export function readFileTail(filePath, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return error.code === 'ENOENT' ? { isMissing: true } : null;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return null;
    }
    const length = Math.min(stats.size, maximumBytes);
    const start = stats.size - length;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(descriptor, buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    return { isMissing: false, text: buffer.subarray(0, bytesRead).toString('utf8'), isTruncated: start > 0, modifiedMs: stats.mtimeMs };
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

// 從中間開始讀的話第一行是半截的，丟掉；最後一行若還在寫（沒有換行），parseJsonLine 解不出來自然略過
function parseTailRecords(tail) {
  const lines = tail.text.split('\n');
  if (tail.isTruncated) {
    lines.shift();
  }
  return lines.map(parseJsonLine).filter((record) => record !== null);
}

function isInterruptedMessage(record) {
  const content = record.message?.content;
  if (typeof content === 'string') {
    return content.startsWith(interruptedMessagePrefix);
  }
  return Array.isArray(content) && content.some((part) => {
    return part?.type === 'text' && typeof part.text === 'string' && part.text.startsWith(interruptedMessagePrefix);
  });
}

// 回傳結束原因，還在跑（或判斷不了）回傳 null。records 是 sub transcript 尾端解出來的紀錄，lastWriteMs 是 transcript 的 mtime。
// 1. 沿用 viewer 的規則（lib/subagent-state.mjs）：SubagentHandback、非背景 sub 的 end_turn、main transcript 的 task-notification
// 2. 最後一筆 user／assistant 是 API 錯誤（isApiErrorMessage）：本機 3 個遇到 API 錯誤的 sub 都停在這一筆，之後沒有任何紀錄；
//    其中一個額度用完的，側邊欄一直沒收到它的 SubagentStop（Claude Code 為什麼沒觸發未驗證）
// 3. 最後一筆 user／assistant 是 `[Request interrupted by user…]`：本機 3 個被中斷的背景 sub 都停在這一行，main transcript 同一刻記 killed
// 4. 很久沒寫入（abandonedAfterMs）
// 早於 startedAtMs 的訊號不算：resume 的 sub 在寫出新紀錄之前，尾端還是上一輪的結束訊號
export function detectSubagentEnd({ startedAtMs, records, meta = null, notification = null, lastWriteMs, nowMs }) {
  const startMs = Number.isFinite(startedAtMs) ? startedAtMs : 0;
  const earliestSignalMs = startMs - startClockToleranceMs;
  const state = createSubAgentState({ agentId: 'tail', discoveredAtMs: nowMs });
  applyMeta(state, meta);
  for (const record of records) {
    applyRecord(state, record);
  }
  if (notification !== null) {
    applyNotification(state, notification);
  }
  // state.lastWriteMs 留 null，不用 viewer 的 10 分鐘 stale：viewer 的 ✓ 之後有寫入會變回 ●，側邊欄拿掉的那一行不會再回來，所以改用第 4 條較長的門檻
  const status = getSubAgentStatus(state, nowMs);
  if (status.isDone && status.atMs >= earliestSignalMs) {
    return status.reason;
  }
  const lastMessage = records.findLast((record) => record.type === 'user' || record.type === 'assistant');
  const lastMessageMs = parseTimestampMs(lastMessage?.timestamp);
  if (lastMessageMs !== null && lastMessageMs >= earliestSignalMs) {
    if (lastMessage.type === 'assistant' && lastMessage.isApiErrorMessage === true) {
      return 'api_error';
    }
    if (lastMessage.type === 'user' && isInterruptedMessage(lastMessage)) {
      return 'interrupted';
    }
  }
  // resume 的 sub 在寫出新紀錄之前 mtime 還是上一輪的，從 startedAtMs 起算
  if (Number.isFinite(lastWriteMs) && nowMs - Math.max(lastWriteMs, startMs) > abandonedAfterMs) {
    return 'abandoned';
  }
  return null;
}

function readSmallJsonFile(filePath, maximumBytes, readTail) {
  const file = readTail(filePath, maximumBytes);
  if (file === null || file.isMissing || file.isTruncated) {
    return null;
  }
  return parseJsonLine(file.text);
}

function collectTaskNotifications(mainTail) {
  const latestByAgentId = new Map();
  if (mainTail === null || mainTail.isMissing) {
    return latestByAgentId;
  }
  const lines = mainTail.text.split('\n');
  if (mainTail.isTruncated) {
    lines.shift();
  }
  for (const line of lines) {
    for (const notification of parseTaskNotifications(line)) {
      const previous = latestByAgentId.get(notification.agentId);
      if (previous === undefined || (notification.timestampMs ?? 0) >= (previous.timestampMs ?? 0)) {
        latestByAgentId.set(notification.agentId, notification);
      }
    }
  }
  return latestByAgentId;
}

// 只靠 SubagentStop 移除的話，因 API 錯誤中斷的 sub 沒收到 SubagentStop（實際發生過，原因未驗證）就會一直卡在側邊欄。每次 hook 觸發時檢查這個 session 每個 sub 的 transcript 尾端。
// sub transcript 在 `<main transcript 去掉 .jsonl>/subagents/agent-<id>.jsonl`；main transcript 路徑不像樣或不存在時不判斷（路徑可能對不上，寧可留著）。
// 只讀檔、不改狀態，回傳判斷為已結束的 sub（含判斷當下的 startedAtMs）：runHook 在 lock 外呼叫，讀 transcript 的時間不算進持有 lock 的時間
export function findEndedSubagents(state, event, { nowMs, readTail = readFileTail, hasTimeLeft = () => true }) {
  const mainTranscriptPath = event.transcriptPath;
  if (state.subagents.length === 0 || !isAbsolute(mainTranscriptPath) || !mainTranscriptPath.endsWith('.jsonl')) {
    return [];
  }
  const mainTail = readTail(mainTranscriptPath, transcriptTailBytes);
  if (mainTail === null || mainTail.isMissing) {
    return [];
  }
  const notifications = collectTaskNotifications(mainTail);
  const subagentsDirectory = join(mainTranscriptPath.slice(0, -'.jsonl'.length), 'subagents');
  const ended = [];
  for (const subagent of state.subagents) {
    // 這次事件的 sub 不判斷：SubagentStart 的（可能是 resume）transcript 還停在上一輪；SubagentStop 的本來就會被 applyEvent 拿掉，不用多讀一次
    if (subagent.id === event.agentId || !isSafeIdentifier(subagent.id)) {
      continue;
    }
    if (!hasTimeLeft()) {
      break;
    }
    const reason = judgeSubagent(subagent, { subagentsDirectory, notifications, nowMs, readTail });
    if (reason !== null) {
      ended.push({ id: subagent.id, startedAtMs: subagent.startedAtMs, reason });
    }
  }
  return ended;
}

// lock 內呼叫，不讀任何檔案。判斷之後、拿到 lock 之前，別的 hook 可能已經改過狀態檔：
// 已經不在的不用拿；startedAtMs 不一樣的是被拿掉後又重新 SubagentStart（resume）的新一輪，判斷的是上一輪，不能拿
export function removeEndedSubagents(state, ended) {
  const removed = [];
  const kept = state.subagents.filter((subagent) => {
    const match = ended.find((entry) => entry.id === subagent.id && entry.startedAtMs === subagent.startedAtMs);
    if (match === undefined) {
      return true;
    }
    removed.push({ id: subagent.id, reason: match.reason });
    return false;
  });
  if (removed.length === 0) {
    return { state, removed };
  }
  return { state: { ...state, subagents: kept }, removed };
}

export function pruneEndedSubagents(state, event, options) {
  return removeEndedSubagents(state, findEndedSubagents(state, event, options));
}

function judgeSubagent(subagent, { subagentsDirectory, notifications, nowMs, readTail }) {
  const transcriptPath = join(subagentsDirectory, `agent-${subagent.id}.jsonl`);
  const tail = readTail(transcriptPath, transcriptTailBytes);
  if (tail === null) {
    return null;
  }
  if (tail.isMissing) {
    const startedAtMs = Number.isFinite(subagent.startedAtMs) ? subagent.startedAtMs : 0;
    return nowMs - startedAtMs > missingTranscriptGraceMs ? 'missing-transcript' : null;
  }
  return detectSubagentEnd({
    startedAtMs: subagent.startedAtMs,
    records: parseTailRecords(tail),
    meta: readSmallJsonFile(join(subagentsDirectory, `agent-${subagent.id}.meta.json`), maximumMetaBytes, readTail),
    notification: notifications.get(subagent.id) ?? null,
    lastWriteMs: tail.modifiedMs,
    nowMs,
  });
}

export function formatTreeLine(branch, agentType) {
  const prefix = `${branch} `;
  const suffix = ` ${runningIcon}`;
  const nameBudget = maximumTokenLength - Array.from(prefix).length - Array.from(suffix).length;
  const nameCharacters = Array.from(agentType);
  const name = nameCharacters.length > nameBudget
    ? `${nameCharacters.slice(0, nameBudget - 1).join('')}…`
    : agentType;
  return `${prefix}${name}${suffix}`;
}

export function buildTreeLines(runningSubagents) {
  const ordered = [...runningSubagents].sort((first, second) => (first.startedAtMs ?? 0) - (second.startedAtMs ?? 0));
  const overflows = ordered.length > maximumTreeLines;
  const visible = overflows ? ordered.slice(0, maximumTreeLines - 1) : ordered;
  const lines = visible.map((subagent, index) => {
    const isLastLine = !overflows && index === visible.length - 1;
    return formatTreeLine(isLastLine ? '└─' : '├─', sanitizeText(subagent.agentType));
  });
  if (overflows) {
    lines.push(`└─ +${ordered.length - visible.length} more`);
  }
  return lines;
}

// herdr 會忽略同 source 中 seq 不大於上一筆的回報；同一毫秒連發時用 +1 保持遞增
export function nextSequence(lastSequence, nowMs) {
  return Math.max(nowMs, (Number.isFinite(lastSequence) ? lastSequence : 0) + 1);
}

export function buildMetadataArguments(paneId, lines, sequence) {
  const argumentList = [
    'pane',
    'report-metadata',
    paneId,
    '--source',
    metadataSource,
    '--seq',
    String(sequence),
  ];
  for (let index = 0; index < maximumTreeLines; index += 1) {
    const tokenName = `sub${index + 1}`;
    if (index < lines.length) {
      argumentList.push('--token', `${tokenName}=${lines[index]}`);
    } else {
      argumentList.push('--clear-token', tokenName);
    }
  }
  return argumentList;
}

export function readProcessInfo(processId) {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    const command = stat.slice(stat.indexOf('(') + 1, commandEnd);
    const fieldsAfterCommand = stat.slice(commandEnd + 2).split(' ');
    // proc(5)：第 3 欄 state、第 4 欄 ppid、第 22 欄 starttime（開機後的 clock ticks）
    return {
      command,
      state: fieldsAfterCommand[0],
      parentProcessId: Number(fieldsAfterCommand[1]),
      startTime: fieldsAfterCommand[19] ?? null,
    };
  } catch {
    return null;
  }
}

// 相鄰的 claude 只算一個：名稱也叫 claude 的 wrapper script（沒有 exec）跟真正的 claude 是直接的父子；
// pane 裡的 claude 用 Bash tool 跑 `claude -p` 時，中間一定隔著 Bash tool 的 shell（實測 Bash tool 的指令跑在 claude 底下的 bash）
export function countClaudeAncestors(startProcessId, readInfo = readProcessInfo) {
  let claudeCount = 0;
  let isPreviousClaude = false;
  let processId = startProcessId;
  for (let depth = 0; depth < maximumAncestorDepth && processId > 1; depth += 1) {
    const info = readInfo(processId);
    if (!info) {
      break;
    }
    const isClaude = info.command === 'claude';
    if (isClaude && !isPreviousClaude) {
      claudeCount += 1;
    }
    isPreviousClaude = isClaude;
    processId = info.parentProcessId;
  }
  return claudeCount;
}

// `herdr pane get` 的 agent_session（herdr 的 claude integration 在 SessionStart 回報）；value 可能是 session id 或 transcript 的絕對路徑
export function parsePaneAgentSession(outputText) {
  let response;
  try {
    response = JSON.parse(outputText);
  } catch {
    return null;
  }
  const agentSession = response?.result?.pane?.agent_session;
  if (agentSession === null || typeof agentSession !== 'object') {
    return null;
  }
  const { value } = agentSession;
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  const sessionId = isAbsolute(value) && value.endsWith('.jsonl') ? basename(value, '.jsonl') : value;
  return {
    agent: typeof agentSession.agent === 'string' ? agentSession.agent : 'claude',
    sessionId,
  };
}

export function queryPaneAgentSession(binaryPath, paneId, timeoutMs) {
  // stdout 一定要 pipe 進來：直接繼承的話 herdr 的 JSON 會變成 hook 的輸出
  const result = spawnSync(binaryPath, ['pane', 'get', paneId], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return parsePaneAgentSession(result.stdout);
}

export function runHerdr(binaryPath, argumentList, timeoutMs) {
  // stdio 全部 ignore：herdr 的輸出若流進 hook 的 stdout，Claude Code 會把它當成 hook 輸出
  spawnSync(binaryPath, argumentList, { stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' });
}

// XDG_RUNTIME_DIR 只是環境變數：資料夾若是別人的、是 symlink、或權限放寬，別的使用者就能預放 symlink 讓這裡寫到別的檔案，寧可不寫
export function prepareStateDirectory(runtimeDirectory, userId) {
  const stateDirectory = join(runtimeDirectory, 'subagent-watch');
  try {
    mkdirSync(stateDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      return null;
    }
  }
  let stats;
  try {
    stats = lstatSync(stateDirectory);
  } catch {
    return null;
  }
  if (!stats.isDirectory() || stats.uid !== userId || (stats.mode & 0o777) !== 0o700) {
    return null;
  }
  return stateDirectory;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createTemporaryPath(filePath) {
  return `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
}

function removeQuietly(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    // 已經不在了
  }
}

// 先寫暫存檔再 rename：viewer 隨時可能在讀，不能讓它讀到寫一半的 JSON。
// 暫存檔名隨機、用 wx 建立：固定的檔名能被預先放 symlink，寫入會跟著 symlink 蓋掉別的檔案
function writeJsonFileAtomically(filePath, data) {
  const temporaryPath = createTemporaryPath(filePath);
  writeFileSync(temporaryPath, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    removeQuietly(temporaryPath);
    throw error;
  }
}

function sleepSync(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

export function parseLockOwner(text) {
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    return null;
  }
  // pid 會交給 process.kill：0 或負數代表整個 process group，一定要是正整數
  if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return null;
  }
  return { pid: owner.pid, startTime: typeof owner.startTime === 'string' ? owner.startTime : null };
}

export function isLockOwnerGone(owner, readInfo = readProcessInfo) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') {
      return true;
    }
    if (error.code !== 'EPERM') {
      return false;
    }
  }
  const info = readInfo(owner.pid);
  if (info === null || info.state === 'Z') {
    return true;
  }
  // pid 被重複使用：同一個 pid 但啟動時間不同，原本的持有者已經不在
  return owner.startTime !== null && info.startTime !== owner.startTime;
}

// lock 的 inode 與內容要從同一個 fd 讀；先 lstat 再 readFile 的話，中間被換掉會拿到對不起來的兩份資料
function readLockFile(filePath) {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return { stats: fstatSync(descriptor), content: readFileSync(descriptor, 'utf8') };
  } finally {
    closeSync(descriptor);
  }
}

// 回傳 null 代表 lock 剛好被釋放，可以馬上再搶；讀不了的 lock 當成有人在用，照常等
function inspectLock(lockPath) {
  const unreadableLock = { inode: null, content: null, isStale: false };
  let lockFile;
  try {
    lockFile = readLockFile(lockPath);
  } catch (error) {
    return error.code === 'ENOENT' ? null : unreadableLock;
  }
  try {
    const owner = parseLockOwner(lockFile.content);
    const ageMs = Date.now() - lockFile.stats.mtimeMs;
    const isStale = ageMs > maximumLockAgeMs || (owner === null ? ageMs > staleLockMs : isLockOwnerGone(owner));
    return { inode: lockFile.stats.ino, content: lockFile.content, isStale };
  } catch {
    return unreadableLock;
  }
}

// 好幾個 process 同時判定同一個 lock 失效時只能有一個去刪。直接 unlink 的話，別人可能剛刪掉舊 lock、建好新的，
// 這裡會刪到新的 lock，兩邊都以為拿到 lock，狀態檔就會掉資料。
// 做法：用 link 搶「<lock>.break-<inode>」這個名字（已存在就失敗），搶到且確認是判定失效的那個 lock 才刪；
// 能拿掉這個 lock 的只有它的持有者（已確認不在）和搶到 .break 的人，所以刪的一定是失效的那個。
// 只比 inode 不夠：ext4 這類檔案系統會把剛釋放的 inode 馬上給下一個新檔，別人接管後新建的 lock 可能拿到同一個 inode，
// 所以內容（持有者的 pid、啟動時間、建立時間）也要跟判定失效時讀到的一字不差；讀不到就不刪
export function breakStaleLock(lockPath, staleInode, staleContent) {
  const breakPath = `${lockPath}.break-${staleInode}`;
  try {
    linkSync(lockPath, breakPath);
  } catch (error) {
    if (error.code === 'EEXIST') {
      removeAbandonedBreakFile(breakPath);
    }
    return false;
  }
  try {
    const breakFile = readLockFile(breakPath);
    if (breakFile.stats.ino !== staleInode || breakFile.content !== staleContent) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    removeQuietly(breakPath);
  }
}

// 搶到 .break 的 process 在刪 lock 前被砍掉時，.break 會一直擋住這個 lock；它只該存在幾微秒，放久了就是沒人管的
function removeAbandonedBreakFile(breakPath) {
  try {
    if (Date.now() - lstatSync(breakPath).ctimeMs > staleLockMs) {
      unlinkSync(breakPath);
    }
  } catch {
    // 已經被清掉
  }
}

// 內容先寫進暫存檔再 link 成 lock：link 跟 wx 一樣「不存在才建立」，而且別人永遠讀不到還沒寫 pid 的 lock
function acquireLock(lockPath, deadlineMs, now) {
  const temporaryPath = createTemporaryPath(lockPath);
  const owner = { pid: process.pid, startTime: readProcessInfo(process.pid)?.startTime ?? null, createdAtMs: Date.now() };
  const ownContent = JSON.stringify(owner);
  let ownInode;
  try {
    writeFileSync(temporaryPath, ownContent, { mode: 0o600, flag: 'wx' });
    ownInode = lstatSync(temporaryPath).ino;
  } catch {
    removeQuietly(temporaryPath);
    return null;
  }
  try {
    while (now() < deadlineMs) {
      try {
        linkSync(temporaryPath, lockPath);
        return { inode: ownInode, content: ownContent };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          return null;
        }
      }
      const lock = inspectLock(lockPath);
      if (lock === null) {
        continue;
      }
      if (lock.isStale && breakStaleLock(lockPath, lock.inode, lock.content)) {
        continue;
      }
      sleepSync(lockRetryIntervalMs);
    }
    return null;
  } finally {
    removeQuietly(temporaryPath);
  }
}

function releaseLock(lockPath, ownLock) {
  try {
    // lock 若已被別人當成失效接管，路徑上是別人的 lock，不能刪；別人新建的 lock 可能拿到同一個 inode（ext4 會重用），內容也要是自己寫的才算
    const lockFile = readLockFile(lockPath);
    if (lockFile.stats.ino === ownLock.inode && lockFile.content === ownLock.content) {
      unlinkSync(lockPath);
    }
  } catch {
    // 已經不在了，或讀不到內容：認不出是自己的就不刪
  }
}

const defaultDependencies = {
  now: () => Date.now(),
  runHerdr,
  isExecutable: isExecutableFile,
  queryPaneAgentSession,
  countClaudeAncestors: () => countClaudeAncestors(process.ppid),
  getUserId: () => process.getuid(),
  readFileTail,
};

export function runHook(rawInput, environment, overrides = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const deadlineMs = dependencies.deadlineMs ?? dependencies.now() + totalBudgetMs;
  const paneId = environment.HERDR_PANE_ID;
  if (!isSafeIdentifier(paneId)) {
    return { action: 'skipped', reason: 'not-in-herdr' };
  }
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  if (!runtimeDirectory) {
    return { action: 'skipped', reason: 'no-runtime-directory' };
  }
  const herdrBinaryPath = resolveHerdrBinPath(environment, dependencies.isExecutable);
  if (herdrBinaryPath === null || !dependencies.isExecutable(herdrBinaryPath)) {
    return { action: 'skipped', reason: 'herdr-not-found' };
  }
  const event = parseHookPayload(rawInput);
  if (!event) {
    return { action: 'skipped', reason: 'irrelevant-payload' };
  }
  // pane 裡的 claude 用 Bash 跑 `claude -p` 時，子 process 繼承同一個 HERDR_PANE_ID；不擋的話會蓋掉主 session 的樹與對照檔。
  // 祖先只有一組 claude 就直接收，不問 herdr：herdr 的 agent_session 在 server 重啟後可能停在重啟前的舊 session，
  // 之後的 startup 回報也不會覆寫（herdr 0.9.3 實測），拿它否決的話主 session 的事件會全部被擋、側邊欄完全不更新。
  // 兩組以上才可能是巢狀：herdr 說的 session 跟 payload 一樣才收（例如名為 claude 的 wrapper 跟 claude 中間隔了 shell），不一樣或查不到就略過
  if (dependencies.countClaudeAncestors() >= 2) {
    const paneQueryTimeoutMs = Math.min(maximumPaneQueryMs, deadlineMs - minimumHerdrBudgetMs - dependencies.now());
    const paneAgentSession = paneQueryTimeoutMs > 0
      ? dependencies.queryPaneAgentSession(herdrBinaryPath, paneId, paneQueryTimeoutMs)
      : null;
    if (paneAgentSession === null || paneAgentSession.agent !== 'claude' || paneAgentSession.sessionId !== event.sessionId) {
      return { action: 'skipped', reason: 'nested-claude' };
    }
  }

  const stateDirectory = prepareStateDirectory(runtimeDirectory, dependencies.getUserId());
  if (stateDirectory === null) {
    return { action: 'skipped', reason: 'unsafe-state-directory' };
  }
  // SessionStart 一開 session 就寫，popup 不用再從可能過期的 herdr 猜；Stop 每回合都會觸發（API 錯誤結束的回合改觸發 StopFailure），只清死掉的 sub 與重畫，不動對照檔
  if (!pruneOnlyEventNames.has(event.eventName)) {
    const paneMapPath = join(stateDirectory, `pane-${paneId}.json`);
    writeJsonFileAtomically(paneMapPath, buildPaneMap(event, readJsonFile(paneMapPath), dependencies.now()));
  }

  const statePath = join(stateDirectory, `session-${event.sessionId}.json`);
  const lockPath = `${statePath}.lock`;
  // 判斷 sub 是否結束要讀 main 與每個 sub 的 transcript 尾端，放在 lock 外：放在 lock 內的話同一個 session 平行觸發的 hook
  // 每個都要多等前面每一個讀完，排在後面的等不到 lock 就放棄，放棄的若是 SubagentStart，那個 sub 永遠不會出現在側邊欄。
  // 狀態檔是 rename 換上的，lock 外讀到的一定是某個完整版本；lock 內再讀一次最新的，只拿掉這裡判斷過的（見 removeEndedSubagents）
  const pruneDeadlineMs = Math.min(dependencies.now() + maximumPruneMs, deadlineMs - minimumHerdrBudgetMs);
  const endedSubagents = findEndedSubagents(normalizeSessionState(readJsonFile(statePath), event.sessionId), event, {
    nowMs: dependencies.now(),
    readTail: dependencies.readFileTail,
    hasTimeLeft: () => dependencies.now() < pruneDeadlineMs,
  });
  // Stop／StopFailure 只會拿掉上面判斷為結束的 sub：一個都沒有的話 lock 內什麼都不會改，不用跟別的 hook 搶 lock（Stop 每回合都會觸發）
  if (pruneOnlyEventNames.has(event.eventName) && endedSubagents.length === 0) {
    return { action: 'unchanged' };
  }
  const ownLock = acquireLock(lockPath, deadlineMs - minimumHerdrBudgetMs, dependencies.now);
  if (ownLock === null) {
    return { action: 'skipped', reason: 'lock-timeout' };
  }
  try {
    // lock 內不讀 transcript：只有狀態檔的讀寫與回報 herdr
    const nowMs = dependencies.now();
    const currentState = normalizeSessionState(readJsonFile(statePath), event.sessionId);
    const applied = applyEvent(currentState, event, nowMs);
    const pruned = removeEndedSubagents(applied.state, endedSubagents);
    const isStateChanged = applied.changed || pruned.removed.length > 0;
    // SessionStart 一定重畫：換 session 後側邊欄要換成新 session 的樹（沒有 sub 就清空），不能等下一個 sub 事件才覆蓋
    if (!isStateChanged && event.eventName !== 'SessionStart') {
      return { action: 'unchanged' };
    }
    const sequence = nextSequence(pruned.state.lastSequence, nowMs);
    const nextState = { ...pruned.state, lastSequence: sequence };
    // 狀態沒變（例：沒有 sub 的新 session）就不寫檔：每個 session 都會觸發 SessionStart，不要每次都在 tmpfs 留一個空的狀態檔
    if (isStateChanged) {
      writeJsonFileAtomically(statePath, nextState);
    }
    const lines = buildTreeLines(nextState.subagents);
    const argumentList = buildMetadataArguments(paneId, lines, sequence);
    const herdrTimeoutMs = Math.max(minimumHerdrBudgetMs, deadlineMs - dependencies.now());
    dependencies.runHerdr(herdrBinaryPath, argumentList, herdrTimeoutMs);
    return { action: 'reported', lines, argumentList, removed: pruned.removed };
  } finally {
    releaseLock(lockPath, ownLock);
  }
}

function main() {
  const startedAtMs = Date.now();
  const exitQuietly = () => {
    process.exit(0);
  };
  process.on('uncaughtException', exitQuietly);
  // stdin 遲遲不關時的保險；同步段落另有自己的時間預算
  setTimeout(exitQuietly, totalBudgetMs).unref();
  if (!process.env.HERDR_PANE_ID || process.stdin.isTTY) {
    exitQuietly();
    return;
  }
  const chunks = [];
  process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
  });
  process.stdin.on('error', exitQuietly);
  process.stdin.on('end', () => {
    try {
      runHook(Buffer.concat(chunks).toString('utf8'), process.env, {
        deadlineMs: startedAtMs + totalBudgetMs,
      });
    } catch {
      // 任何錯誤都不能影響 Claude session
    }
    exitQuietly();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
