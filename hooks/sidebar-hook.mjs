// Claude Code SubagentStart／SubagentStop hook：更新 herdr 側邊欄 claude 那一列底下的 sub agent 樹狀行。
// 這是全域 hook，會套用到使用者所有 Claude session：永遠 exit 0、stdout 不輸出、1 秒內結束。
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExecutableFile, resolveHerdrBinPath } from '../lib/herdr.mjs';

export const metadataSource = 'subagent.watch';
export const maximumTreeLines = 5;
export const maximumTokenLength = 80;
export const runningIcon = '●';
export const doneIcon = '✓';

// 加上 node 啟動與 herdr 最低預算後仍要在 1 秒內結束
const totalBudgetMs = 800;
const minimumHerdrBudgetMs = 100;
const lockRetryIntervalMs = 10;
const staleLockMs = 2000;
const maximumAncestorDepth = 64;
const safeIdentifierPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const controlCharacterPattern = /\p{Cc}/gu;

export function isSafeIdentifier(value) {
  return typeof value === 'string' && safeIdentifierPattern.test(value) && value !== '.' && value !== '..';
}

// herdr 會移除控制字元並 trim；先做一樣的處理，80 字截斷的長度計算才會跟 herdr 一致
export function sanitizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(controlCharacterPattern, '').trim();
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
    return subagent && typeof subagent === 'object' && typeof subagent.id === 'string';
  });
  return {
    sessionId,
    lastSequence: Number.isFinite(candidate.lastSequence) ? candidate.lastSequence : 0,
    subagents,
  };
}

export function applyEvent(state, event, nowMs) {
  const subagents = state.subagents.map((subagent) => ({ ...subagent }));
  const existing = subagents.find((subagent) => subagent.id === event.agentId);
  if (event.eventName === 'SubagentStart') {
    // SubagentStart 在 resume 同一個 sub 時也會再觸發：改回 running，不新增一筆
    if (existing) {
      existing.status = 'running';
      existing.agentType = event.agentType;
      existing.endedAtMs = null;
    } else {
      subagents.push({
        id: event.agentId,
        agentType: event.agentType,
        status: 'running',
        startedAtMs: nowMs,
        endedAtMs: null,
      });
    }
    return { changed: true, state: { ...state, subagents } };
  }
  // 沒看過 start 的 stop 不收：可能是內部 agent，或 hook 安裝前就啟動的 sub
  if (!existing) {
    return { changed: false, state };
  }
  existing.status = 'done';
  existing.endedAtMs = nowMs;
  return { changed: true, state: { ...state, subagents } };
}

export function formatTreeLine(branch, agentType, icon) {
  const prefix = `${branch} `;
  const suffix = ` ${icon}`;
  const nameBudget = maximumTokenLength - Array.from(prefix).length - Array.from(suffix).length;
  const nameCharacters = Array.from(agentType);
  const name = nameCharacters.length > nameBudget
    ? `${nameCharacters.slice(0, nameBudget - 1).join('')}…`
    : agentType;
  return `${prefix}${name}${suffix}`;
}

export function orderSubagents(subagents) {
  const running = subagents
    .filter((subagent) => subagent.status === 'running')
    .sort((first, second) => (first.startedAtMs ?? 0) - (second.startedAtMs ?? 0));
  const finished = subagents
    .filter((subagent) => subagent.status !== 'running')
    .sort((first, second) => (second.endedAtMs ?? 0) - (first.endedAtMs ?? 0));
  return [...running, ...finished];
}

export function buildTreeLines(subagents) {
  const ordered = orderSubagents(subagents);
  const overflows = ordered.length > maximumTreeLines;
  const visible = overflows ? ordered.slice(0, maximumTreeLines - 1) : ordered;
  const lines = visible.map((subagent, index) => {
    const isLastLine = !overflows && index === visible.length - 1;
    const icon = subagent.status === 'running' ? runningIcon : doneIcon;
    return formatTreeLine(isLastLine ? '└─' : '├─', sanitizeText(subagent.agentType), icon);
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
    return { command, parentProcessId: Number(fieldsAfterCommand[1]) };
  } catch {
    return null;
  }
}

export function countClaudeAncestors(startProcessId, readInfo = readProcessInfo) {
  let claudeCount = 0;
  let processId = startProcessId;
  for (let depth = 0; depth < maximumAncestorDepth && processId > 1; depth += 1) {
    const info = readInfo(processId);
    if (!info) {
      break;
    }
    if (info.command === 'claude') {
      claudeCount += 1;
    }
    processId = info.parentProcessId;
  }
  return claudeCount;
}

export function runHerdr(binaryPath, argumentList, timeoutMs) {
  // stdio 全部 ignore：herdr 的輸出若流進 hook 的 stdout，Claude Code 會把它當成 hook 輸出
  spawnSync(binaryPath, argumentList, { stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// 先寫暫存檔再 rename：viewer 隨時可能在讀，不能讓它讀到寫一半的 JSON
function writeJsonFileAtomically(filePath, data) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

function sleepSync(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function acquireLock(lockPath, deadlineMs) {
  while (Date.now() < deadlineMs) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return false;
      }
    }
    try {
      // 持有者被 watchdog 或 Claude Code 的 timeout 砍掉時 lock 會留著，超過 staleLockMs 視為失效
      if (Date.now() - statSync(lockPath).mtimeMs > staleLockMs) {
        unlinkSync(lockPath);
        continue;
      }
    } catch {
      continue;
    }
    sleepSync(lockRetryIntervalMs);
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // 已被別的 process 當成 stale lock 清掉，不用處理
  }
}

const defaultDependencies = {
  now: () => Date.now(),
  runHerdr,
  isExecutable: isExecutableFile,
  countClaudeAncestors: () => countClaudeAncestors(process.ppid),
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
  // pane 裡的 claude 用 Bash 跑 `claude -p` 時，子 process 繼承同一個 HERDR_PANE_ID；不擋的話會蓋掉主 session 的樹與對照檔
  if (dependencies.countClaudeAncestors() >= 2) {
    return { action: 'skipped', reason: 'nested-claude' };
  }

  const stateDirectory = join(runtimeDirectory, 'subagent-watch');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  // 對照檔合約（viewer 讀）：欄位固定為 sessionId、transcriptPath、cwd、updatedAtMs，不准改
  writeJsonFileAtomically(join(stateDirectory, `pane-${paneId}.json`), {
    sessionId: event.sessionId,
    transcriptPath: event.transcriptPath,
    cwd: event.cwd,
    updatedAtMs: dependencies.now(),
  });

  const statePath = join(stateDirectory, `session-${event.sessionId}.json`);
  const lockPath = `${statePath}.lock`;
  if (!acquireLock(lockPath, deadlineMs - minimumHerdrBudgetMs)) {
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
    releaseLock(lockPath);
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
