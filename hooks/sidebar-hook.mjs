// Claude Code SessionStart／SubagentStart／SubagentStop／Stop／StopFailure hook：更新 herdr 側邊欄 claude 那一列底下的 sub agent 樹狀行（只列跑中的，歷史看 popup viewer），
// 並寫 pane 對照檔給 popup viewer。
// 這是全域 hook，會套用到使用者所有 Claude session：永遠 exit 0、stdout 不輸出、在 totalBudgetMs 內結束。
// 跑中的 sub 一個一個檔（sub-<sessionId>-<agentId>.json），每個 hook 只改自己那個 sub 的檔，不用 lock；
// 平行的 hook 各自回報，靠 herdr 的 --seq 只留最新的一筆（見 takeSequence）
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
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExecutableFile, resolveHerdrBinPath } from '../lib/herdr.mjs';
import { applyMeta, applyRecord, createSubAgentState, getSubAgentStatus } from '../lib/subagent-state.mjs';
import { parseJsonLine, parseTaskNotifications, parseTimestampMs } from '../lib/transcript.mjs';

export const metadataSource = 'subagent.watch';
export const maximumTreeLines = 5;
export const maximumTokenLength = 80;
export const runningIcon = '●';

// Stop 每回合都會觸發，transcript 可能上百 MB：判斷 sub 結束只需要最後幾筆，只讀尾端
export const transcriptTailBytes = 64 * 1024;
// transcript 還不存在的 sub 先留著：SubagentStart 觸發時 sub 可能還沒寫出第一行，超過這段時間仍不存在才當成沒有成功啟動
export const missingTranscriptGraceMs = 2 * 60 * 1000;
// 清除只是 SubagentStop 漏掉時的安全網：看到結束訊號之後，最後一筆紀錄與 transcript mtime 都要過了這麼久才清。
// resume（SendMessage）會觸發新的 SubagentStart，但新一輪寫出第一筆紀錄之前，transcript 尾端還是上一輪的結束訊號（review 的 E2E：上一輪結束約 2 秒後就 resume）。
// 本機 21 次 resume：SendMessage 到新一輪第一筆紀錄最多約 5 秒、到第一筆 assistant 回應最多約 10 秒。
// 用本機 210 個 sub（231 輪）的真實時間軸模擬：舊規則（訊號不早於 SubagentStart 前 2 秒就清）誤刪 4 次，這個規則 0 次；代價是漏掉 SubagentStop 的 sub 要等 2 分鐘後的下一次 hook 才拿掉
export const quietAfterEndSignalMs = 2 * 60 * 1000;
const maximumMetaBytes = 64 * 1024;
const interruptedMessagePrefix = '[Request interrupted by user';
const sessionEventNames = new Set(['SessionStart', 'Stop', 'StopFailure']);
const subagentEventNames = new Set(['SubagentStart', 'SubagentStop']);
// 官方文件：回合因 API 錯誤結束時不觸發 Stop、改觸發 StopFailure。兩個都只清死掉的 sub 與重畫，不寫對照檔；
// 不接 StopFailure 的話，額度用完的那一回合留下的 sub 要等到這個 session 下一次 hook 事件才拿掉
const pruneOnlyEventNames = new Set(['Stop', 'StopFailure']);
// 官方文件列的 source：startup、resume、clear、compact、fork；認不得的記成 unknown，標記照樣成立
const sessionStartSourcePattern = /^[a-z_]{1,32}$/;

// 整體時間上限，從 main() 開始算（不含 node 啟動）。沒有 lock 之後不會再「等」別的 hook，剩下的只有搶 CPU、判斷 sub 是否結束（另有 maximumPruneMs）與 herdr 本身；
// herdr 呼叫的 timeout 就是剩下的預算，herdr 被砍掉就是漏掉一次更新，所以預算不跟著縮：調小只會讓很忙時的 herdr 更容易被砍，平常又碰不到上限。
// 實測（8 個 hook 同時觸發、假 herdr 每次 30 ms、5 個跑中的 sub 各有約 1 MB 的 transcript；時間含 node 啟動）：一般情況每個 hook 最多約 90 ms（lock 版約 630 ms）；
// 鎖在 1 個 CPU、旁邊 4 個吃滿 CPU 的 process 時最多約 650 ms（lock 版約 1.3 秒），離 1.5 秒還很遠。
// 上限要離 settings.json 的 hook timeout（hookTimeoutSeconds，5 秒）夠遠；測試檢查預算不超過 timeout 的一半
export const totalBudgetMs = 1500;
const minimumHerdrBudgetMs = 100;
const maximumPaneQueryMs = 300;
// 判斷 sub 是否結束最多用這麼久，剩下的 sub 留到下一次事件：判斷拖越久，這次事件自己的回報越晚送出。
// 實測 5 個 sub、真實大小 transcript：單獨跑約 10 ms，8 個 hook 同時跑最多約 22 ms；8 個擠在 1 個 CPU 上、旁邊還有 4 個吃滿 CPU 的 process 時每個 hook 都會碰到上限
export const maximumPruneMs = 100;
// 跑中的 sub 一個一個檔；暫存檔（.tmp 結尾）與清除時暫時改名的檔不會被當成 sub
const subagentFilePrefix = 'sub-';
const subagentFileSuffix = '.json';
// herdr 的 --seq 是 u64（實測超過上限 exit 1）；開機時間讀不到時的基準，理由見 takeSequence
export const fallbackSequenceBaseNs = 10n ** 17n;
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

export function subagentFileName(sessionId, agentId) {
  return `${subagentFilePrefix}${sessionId}-${agentId}${subagentFileSuffix}`;
}

// sub 檔內容：{ sessionId, id, agentType, startedAtMs }（id、agentType、startedAtMs 沿用舊版狀態檔每一筆的欄位）。
// 只看檔名前綴的話，某個 session id 剛好是另一個 session id 加上「-…」時會混進來，所以內容的 sessionId 與 id 要跟檔名完全對得上才算
export function parseSubagentFile(text, sessionId, fileName) {
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object' || entry.sessionId !== sessionId || !isSafeIdentifier(entry.id)) {
    return null;
  }
  if (fileName !== subagentFileName(sessionId, entry.id) || typeof entry.agentType !== 'string' || !Number.isFinite(entry.startedAtMs)) {
    return null;
  }
  return { id: entry.id, agentType: entry.agentType, startedAtMs: entry.startedAtMs };
}

function readSubagentFile(filePath, sessionId, fileName) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    // 讀的當下被別的 hook 刪掉（SubagentStop 或清除）：當成已經結束
    return null;
  }
  return parseSubagentFile(text, sessionId, fileName);
}

// 這個 session 跑中的 sub。readdir 與逐一讀檔之間別的 hook 可能改了資料夾：讀到的不一定是同一刻的狀態，
// 但取 seq 在 readdir 之前，比較晚改動的 hook 的 seq 一定比較大，herdr 最後留下的是它的（見 takeSequence）
export function listSessionSubagents(stateDirectory, sessionId) {
  const prefix = `${subagentFilePrefix}${sessionId}-`;
  const subagents = [];
  for (const name of readdirSync(stateDirectory)) {
    if (!name.startsWith(prefix) || !name.endsWith(subagentFileSuffix)) {
      continue;
    }
    const subagent = readSubagentFile(join(stateDirectory, name), sessionId, name);
    if (subagent !== null) {
      subagents.push(subagent);
    }
  }
  return subagents;
}

// 舊版（一個 session 一個狀態檔＋lock）留下的跑中 sub：status 為 done 的是更舊版本留下的已結束項目，不搬
export function readLegacySubagents(candidate) {
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.subagents)) {
    return [];
  }
  return candidate.subagents.filter((subagent) => {
    return subagent && typeof subagent === 'object' && isSafeIdentifier(subagent.id) && typeof subagent.agentType === 'string' && subagent.status !== 'done';
  }).map((subagent) => {
    return { id: subagent.id, agentType: subagent.agentType, startedAtMs: Number.isFinite(subagent.startedAtMs) ? subagent.startedAtMs : 0 };
  });
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

function isToolResultOnly(record, toolUseIds = null) {
  const content = record.message?.content;
  return record.type === 'user' && Array.isArray(content) && content.length > 0 && content.every((part) => {
    return part?.type === 'tool_result' && (toolUseIds === null || toolUseIds.has(part.tool_use_id));
  });
}

function findLatestTimestampMs(records) {
  let latestMs = null;
  for (const record of records) {
    const timestampMs = parseTimestampMs(record.timestamp);
    if (timestampMs !== null && (latestMs === null || timestampMs > latestMs)) {
      latestMs = timestampMs;
    }
  }
  return latestMs;
}

// 最後一筆 assistant 是 SubagentHandback 或非背景 sub 的 end_turn（沿用 viewer 的 lib/subagent-state.mjs）：
// 之後只能接它自己 tool_use 的 tool_result（SubagentHandback 那一筆），有別的紀錄就代表 sub 還在動
function findTurnEndSignal(messages, meta) {
  const assistantIndex = messages.findLastIndex((record) => record.type === 'assistant');
  if (assistantIndex === -1) {
    return null;
  }
  const assistant = messages[assistantIndex];
  const parts = Array.isArray(assistant.message?.content) ? assistant.message.content : [];
  const toolUseIds = new Set(parts.filter((part) => part?.type === 'tool_use').map((part) => part.id));
  if (!messages.slice(assistantIndex + 1).every((record) => isToolResultOnly(record, toolUseIds))) {
    return null;
  }
  const state = createSubAgentState({ agentId: 'tail', discoveredAtMs: 0 });
  applyMeta(state, meta);
  applyRecord(state, assistant);
  // state.lastWriteMs 留 null，不用 viewer 的 10 分鐘 stale：沒有結束訊號的 sub 一律留著
  const status = getSubAgentStatus(state, 0);
  return status.isDone ? { atMs: status.atMs, reason: status.reason } : null;
}

// 最後一筆有效紀錄（user／assistant）是不是結束訊號，是的話回傳 { atMs, reason }：
// 1. main transcript 的 task-notification（completed／killed／failed），時間不早於最後一筆有效紀錄；
//    最後一筆是新送進來的指令（不是 tool_result 的 user）時不信：resume 送進來的指令之後 sub 會繼續跑，通知是上一輪的
// 2. 最後一筆是 API 錯誤（isApiErrorMessage）：本機 3 個遇到 API 錯誤的 sub 都停在這一筆，之後沒有任何紀錄；
//    其中一個額度用完的，側邊欄一直沒收到它的 SubagentStop（Claude Code 為什麼沒觸發未驗證）
// 3. 最後一筆是 `[Request interrupted by user…]`：本機 3 個被中斷的背景 sub 都停在這一行，main transcript 同一刻記 killed
// 4. SubagentHandback、非背景 sub 的 end_turn（findTurnEndSignal）
function findEndSignal(records, meta, notification) {
  const messages = records.filter((record) => record.type === 'user' || record.type === 'assistant');
  const lastMessage = messages.at(-1);
  const lastMessageMs = parseTimestampMs(lastMessage?.timestamp);
  if (lastMessageMs === null) {
    return null;
  }
  const isNewPrompt = lastMessage.type === 'user' && !isToolResultOnly(lastMessage);
  if (notification !== null && notification.timestampMs !== null && notification.timestampMs >= lastMessageMs && !isNewPrompt) {
    return { atMs: notification.timestampMs, reason: notification.status };
  }
  if (lastMessage.type === 'assistant' && lastMessage.isApiErrorMessage === true) {
    return { atMs: lastMessageMs, reason: 'api_error' };
  }
  if (lastMessage.type === 'user' && isInterruptedMessage(lastMessage)) {
    return { atMs: lastMessageMs, reason: 'interrupted' };
  }
  return findTurnEndSignal(messages, meta);
}

// 回傳結束原因，還在跑（或判斷不了）回傳 null。records 是 sub transcript 尾端解出來的紀錄，lastWriteMs 是 transcript 的 mtime。
// 只當 SubagentStop 漏掉時的安全網，三個條件都成立才算結束：
// 1. 最後一筆有效紀錄是結束訊號（findEndSignal）
// 2. 訊號不早於這一輪的 SubagentStart（startedAtMs，不留誤差）：resume 的 sub 在寫出新紀錄之前，尾端還是上一輪的結束訊號
// 3. 最後一筆紀錄、transcript mtime、訊號本身都已經過了 quietAfterEndSignalMs：resume 後新一輪還沒寫紀錄的那幾秒不會被清
// 沒有結束訊號就一直留著。舊版另有「60 分鐘沒寫入就清」，但本機 2 個 sub 在同一輪內 7 小時、23 小時沒寫入之後繼續跑（推測是電腦睡眠，未驗證），會被誤刪
export function detectSubagentEnd({ startedAtMs, records, meta = null, notification = null, lastWriteMs, nowMs }) {
  const signal = findEndSignal(records, meta, notification);
  const startMs = Number.isFinite(startedAtMs) ? startedAtMs : 0;
  if (signal === null || signal.atMs < startMs) {
    return null;
  }
  const lastActivityMs = Math.max(signal.atMs, findLatestTimestampMs(records) ?? signal.atMs, Number.isFinite(lastWriteMs) ? lastWriteMs : signal.atMs);
  return nowMs - lastActivityMs >= quietAfterEndSignalMs ? signal.reason : null;
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
    const parsed = parseTaskNotifications(line);
    // 只取 enqueue（通知產生的時間）。remove 是主 session 把通知出列的時間，可能晚於 resume 或 sub 之後的紀錄：
    // 本機一個 sub 在 SubagentHandback 之後因排隊訊息繼續跑 Bash，那則通知的出列時間比當時最後一筆紀錄晚，會被當成新的結束訊號
    if (parsed.length === 0 || parseJsonLine(line)?.operation !== 'enqueue') {
      continue;
    }
    for (const notification of parsed) {
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
// 只讀檔、不改任何檔案，回傳判斷為已結束的 sub（含判斷當下的 startedAtMs），刪檔由 removeEndedSubagentFile 做
export function findEndedSubagents(subagents, event, { nowMs, readTail = readFileTail, hasTimeLeft = () => true }) {
  const mainTranscriptPath = event.transcriptPath;
  if (subagents.length === 0 || !isAbsolute(mainTranscriptPath) || !mainTranscriptPath.endsWith('.jsonl')) {
    return [];
  }
  const mainTail = readTail(mainTranscriptPath, transcriptTailBytes);
  if (mainTail === null || mainTail.isMissing) {
    return [];
  }
  const notifications = collectTaskNotifications(mainTail);
  const subagentsDirectory = join(mainTranscriptPath.slice(0, -'.jsonl'.length), 'subagents');
  const ended = [];
  for (const subagent of subagents) {
    // 這次事件的 sub 不判斷：SubagentStart 的（可能是 resume）transcript 還停在上一輪；SubagentStop 的檔本來就刪了，不用多讀一次
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

// 判斷之後到刪檔之前，別的 hook 可能已經改過這個 sub 的檔：已經不在的（SubagentStop 或別的 hook 清掉了）不用刪；
// startedAtMs 不一樣的是又 SubagentStart（resume）的新一輪，判斷的是上一輪，不能刪。
// 先讀再 unlink 的話，兩步之間 resume 換上的新檔會被刪掉，所以先 rename 到隨機的暫存名「拿走」路徑上那一份，再看拿到的是不是判斷的那一輪：
// rename 是原子的，拿到的一定是某個完整版本；不是的話用 link 放回去（路徑上已經有更新的檔就不放，link 不會覆蓋）。
// 拿走到放回之間，別的 hook readdir 會看不到這個 sub；放回之後這次事件一定會取 seq、重新 readdir 再回報，seq 比那些 hook 大，側邊欄最後仍會列出它。
// 回傳 'removed'、'gone'（已經不在）或 'restored'（放回，或路徑上已有更新的檔）
export function removeEndedSubagentFile(stateDirectory, sessionId, ended) {
  const fileName = subagentFileName(sessionId, ended.id);
  const filePath = join(stateDirectory, fileName);
  const claimedPath = createTemporaryPath(filePath);
  try {
    renameSync(filePath, claimedPath);
  } catch {
    return 'gone';
  }
  const claimed = readSubagentFile(claimedPath, sessionId, fileName);
  if (claimed !== null && claimed.startedAtMs === ended.startedAtMs) {
    removeQuietly(claimedPath);
    return 'removed';
  }
  try {
    linkSync(claimedPath, filePath);
  } catch {
    // 路徑上已經有更新的檔（又一次 SubagentStart），留著新的
  }
  removeQuietly(claimedPath);
  return 'restored';
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

// 同一毫秒啟動的用 id 排：readdir 的順序不固定，不排的話平行的 hook 會畫出順序不同的樹
export function buildTreeLines(runningSubagents) {
  const ordered = [...runningSubagents].sort((first, second) => {
    const difference = (first.startedAtMs ?? 0) - (second.startedAtMs ?? 0);
    if (difference !== 0) {
      return difference;
    }
    return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  });
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

// /proc/stat 的 btime：開機時刻（epoch 秒）。讀不到或不像樣回傳 null
export function readBootTimeSeconds(readText = (filePath) => readFileSync(filePath, 'utf8')) {
  let text;
  try {
    text = readText('/proc/stat');
  } catch {
    return null;
  }
  const match = /^btime (\d{1,19})$/m.exec(text);
  if (match === null) {
    return null;
  }
  const seconds = BigInt(match[1]);
  return seconds > 0n ? seconds : null;
}

// herdr 實測：同一個 (pane, source) 的 --seq 小於或等於上次收下的就忽略（exit 0、沒有訊息），比較大才收；不同 pane、不同 source 各自計算。
// 沒有 lock 之後，同一個 session 平行的 hook 各自改自己的檔、各自回報，側邊欄最後顯示的是 seq 最大的那一筆。
// seq 在「改完檔（寫／刪自己的檔、清掉結束的 sub）之後、readdir 之前」取：改檔的 hook 取 seq 時改動已經完成，
// seq 比它大的回報一定是之後才 readdir，看得到這個改動；在改動完成之前就 readdir 的回報，seq 一定比較小，會被 herdr 忽略。
// 所以最後留下的一定包含每一個改動。前提是不同 process 取的 seq 夠細、不會撞號（撞號時後到的被忽略）。
// POC（8 個 hook 同時觸發、20 輪×3 種情境：同時 start、同時 stop、start 後馬上 stop；一般／taskset -c 0／再加 4 或 6 個吃滿 CPU 的 process）：
// 這個做法 0 次漏掉；seq 用毫秒時撞號漏 22/60，seq 在寫檔之前取漏 1–2/60，不帶 seq 漏 10–19/60。
// 值是「開機時刻（btime 秒）× 1e9 ＋ monotonic ns」，BigInt 算、字串傳：monotonic（process.hrtime，所有 process 共用同一個時鐘）解析度夠細，
// 但重開機歸零；herdr 若重開機後還記得舊的 seq（未驗證）就會忽略之後全部的回報，加上開機時刻後跨重開機也遞增。
// 現在約 1.79e18，離 u64 上限（約 1.8e19）很遠；舊版的 seq 是毫秒（約 1.79e12），升級後新的一定比較大。
// 讀不到 btime 時改用固定基準 1e17 ＋ monotonic ns：仍然夠細、仍大於舊版的毫秒 seq，只是重開機後會從小的值重來（同上，herdr 是否記得未驗證）。
// 不用 Date.now()：毫秒解析度在平行 hook 間會撞號（上面的 22/60）；Date.now() 毫秒 × 1e6 ＋ hrtime 的 ns 餘數也不行，
// 兩個時鐘的毫秒邊界不一致，同一毫秒內的先後會排錯。讀不到 btime 只會發生在沒有 /proc 的環境（README 只支援 Linux），所以不另外想辦法跨重開機。
// 已知風險：btime 是「現在的系統時間 − 開機後經過的時間」，取到秒（無條件捨去），系統時間被往回調（手動改時間、NTP step）時 btime 跟著變小，只往回調幾 ms 也可能退約 1 秒；
// 在時間追上之前 seq 可能小於調整前送出的，那段時間的回報都會被忽略，往回調多久側邊欄就可能凍結多久（再加最多 1 秒）。依 Linux timekeeping 的算法，睡眠與 NTP 慢慢校正（slew）不會改變 btime（未實測）
export function takeSequence(bootTimeSeconds, monotonicNs) {
  const baseNs = bootTimeSeconds === null ? fallbackSequenceBaseNs : bootTimeSeconds * 1_000_000_000n;
  return baseNs + monotonicNs;
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
    // proc(5)：第 4 欄 ppid
    return {
      command,
      parentProcessId: Number(fieldsAfterCommand[1]),
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

// 路徑上已經有檔就不寫：link 跟 wx 一樣「不存在才建立」，搬舊版狀態檔時不會蓋掉新版 hook 已經寫好的 sub 檔
function writeJsonFileIfMissing(filePath, data) {
  const temporaryPath = createTemporaryPath(filePath);
  writeFileSync(temporaryPath, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temporaryPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    removeQuietly(temporaryPath);
  }
}

function removeFileIfPresent(filePath) {
  try {
    unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// 舊版每個 session 一個 session-<id>.json（用 lock 串起讀改寫）。升級時還在跑的 sub 只記在那個檔裡：不搬的話，升級後這個 session 第一次重畫就把它們從側邊欄拿掉，
// 之後它們的 SubagentStop 也找不到自己的檔。每個事件都看一下自己 session 的舊檔（不存在只多一次 open 失敗），搬成 sub 檔（已經有的不蓋）後刪掉；
// 搬過來的若其實已經結束，同一次事件的清除就會判斷。舊版的 .lock、.break-* 不理：新版不讀它們，跟狀態檔一樣在 tmpfs 上，重開機（或登出時 XDG_RUNTIME_DIR 被清掉）就沒了
function migrateLegacySessionFile(stateDirectory, sessionId) {
  const legacyPath = join(stateDirectory, `session-${sessionId}.json`);
  let text;
  try {
    text = readFileSync(legacyPath, 'utf8');
  } catch {
    return 0;
  }
  let candidate = null;
  try {
    candidate = JSON.parse(text);
  } catch {
    // 壞掉的舊檔：沒有能搬的，照樣刪掉
  }
  let migratedCount = 0;
  for (const subagent of readLegacySubagents(candidate)) {
    if (writeJsonFileIfMissing(join(stateDirectory, subagentFileName(sessionId, subagent.id)), { sessionId, ...subagent })) {
      migratedCount += 1;
    }
  }
  removeQuietly(legacyPath);
  return migratedCount;
}

const defaultDependencies = {
  now: () => Date.now(),
  monotonicNs: () => process.hrtime.bigint(),
  readBootTimeSeconds: () => readBootTimeSeconds(),
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

  const migratedCount = migrateLegacySessionFile(stateDirectory, event.sessionId);
  // 每個 hook 只改自己那個 sub 的檔，不跟別的 hook 搶同一個檔
  let isOwnFileChanged = false;
  const ownFilePath = event.agentId === null ? null : join(stateDirectory, subagentFileName(event.sessionId, event.agentId));
  if (event.eventName === 'SubagentStart') {
    // resume 時檔案還在（上一輪的 SubagentStop 沒收到）也直接覆寫，啟動時間換成這一次的：
    // 沿用舊的話，上一輪的結束訊號會晚於啟動時間，正在跑的這一輪會被當成已經結束
    writeJsonFileAtomically(ownFilePath, { sessionId: event.sessionId, id: event.agentId, agentType: event.agentType, startedAtMs: dependencies.now() });
    isOwnFileChanged = true;
  } else if (event.eventName === 'SubagentStop') {
    // 檔不存在（沒看過 start 的 stop：可能是內部 agent，或 hook 安裝前就啟動的 sub）不算改動
    isOwnFileChanged = removeFileIfPresent(ownFilePath);
  }

  const pruneDeadlineMs = Math.min(dependencies.now() + maximumPruneMs, deadlineMs - minimumHerdrBudgetMs);
  const endedSubagents = findEndedSubagents(listSessionSubagents(stateDirectory, event.sessionId), event, {
    nowMs: dependencies.now(),
    readTail: dependencies.readFileTail,
    hasTimeLeft: () => dependencies.now() < pruneDeadlineMs,
  });
  const removed = [];
  let isRestored = false;
  for (const ended of endedSubagents) {
    const outcome = removeEndedSubagentFile(stateDirectory, event.sessionId, ended);
    if (outcome === 'removed') {
      removed.push({ id: ended.id, reason: ended.reason });
    } else if (outcome === 'restored') {
      isRestored = true;
    }
  }
  // 有改過任何檔就一定要回報（放回 resume 的檔也算：放回之前別的 hook 可能 readdir 時沒看到它）。
  // SessionStart 一定重畫：換 session 後側邊欄要換成新 session 的樹（沒有 sub 就清空），不能等下一個 sub 事件才覆蓋。
  // Stop／StopFailure 每回合都會觸發，沒清掉任何 sub 就不呼叫 herdr
  const isChanged = migratedCount > 0 || isOwnFileChanged || removed.length > 0 || isRestored;
  if (!isChanged && event.eventName !== 'SessionStart') {
    return { action: 'unchanged' };
  }
  // seq 一定要在上面所有改檔之後、下面 readdir 之前取，理由見 takeSequence
  const sequence = takeSequence(dependencies.readBootTimeSeconds(), dependencies.monotonicNs());
  const lines = buildTreeLines(listSessionSubagents(stateDirectory, event.sessionId));
  const argumentList = buildMetadataArguments(paneId, lines, sequence);
  const herdrTimeoutMs = Math.max(minimumHerdrBudgetMs, deadlineMs - dependencies.now());
  dependencies.runHerdr(herdrBinaryPath, argumentList, herdrTimeoutMs);
  return { action: 'reported', lines, argumentList, removed };
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
