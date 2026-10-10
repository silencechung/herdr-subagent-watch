// Claude Code SubagentStart／SubagentStop hook：更新 herdr 側邊欄 claude 那一列底下的 sub agent 樹狀行（只列跑中的，歷史看 popup viewer）。
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
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExecutableFile, resolveHerdrBinPath } from '../lib/herdr.mjs';

export const metadataSource = 'subagent.watch';
export const maximumTreeLines = 5;
export const maximumTokenLength = 80;
export const runningIcon = '●';

// 加上 node 啟動與 herdr 最低預算後仍要在 1 秒內結束
const totalBudgetMs = 800;
const minimumHerdrBudgetMs = 100;
const maximumPaneQueryMs = 300;
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
  if (eventName !== 'SubagentStart' && eventName !== 'SubagentStop') {
    return null;
  }
  if (!isSafeIdentifier(payload.session_id) || !isSafeIdentifier(payload.agent_id)) {
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
  // 對照檔合約（viewer 讀）：欄位固定為 sessionId、transcriptPath、cwd、updatedAtMs，不准改
  writeJsonFileAtomically(join(stateDirectory, `pane-${paneId}.json`), {
    sessionId: event.sessionId,
    transcriptPath: event.transcriptPath,
    cwd: event.cwd,
    updatedAtMs: dependencies.now(),
  });

  const statePath = join(stateDirectory, `session-${event.sessionId}.json`);
  const lockPath = `${statePath}.lock`;
  const ownLock = acquireLock(lockPath, deadlineMs - minimumHerdrBudgetMs, dependencies.now);
  if (ownLock === null) {
    return { action: 'skipped', reason: 'lock-timeout' };
  }
  try {
    const nowMs = dependencies.now();
    const currentState = normalizeSessionState(readJsonFile(statePath), event.sessionId);
    const { changed, state } = applyEvent(currentState, event, nowMs);
    if (!changed) {
      return { action: 'unchanged' };
    }
    const sequence = nextSequence(state.lastSequence, nowMs);
    const nextState = { ...state, lastSequence: sequence };
    writeJsonFileAtomically(statePath, nextState);
    const lines = buildTreeLines(nextState.subagents);
    const argumentList = buildMetadataArguments(paneId, lines, sequence);
    const herdrTimeoutMs = Math.max(minimumHerdrBudgetMs, deadlineMs - dependencies.now());
    dependencies.runHerdr(herdrBinaryPath, argumentList, herdrTimeoutMs);
    return { action: 'reported', lines, argumentList };
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
