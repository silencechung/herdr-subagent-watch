import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getClaudeProjectsDirectory } from './claude-config.mjs';
import { herdrNotFoundMessage, resolveHerdrBinPath } from './herdr.mjs';
import { sanitizeText, truncateWithEllipsis } from './text.mjs';
import { parseJsonLine } from './transcript.mjs';

const maximumAgentNameWidth = 40;
const herdrTimeoutMs = 3000;
export const noAgentPaneMessage = 'No Claude Code session in this pane';

// sessionId／paneId 會拼進路徑，來源包含別人寫的對照檔，擋掉任何能跳出資料夾的字元
const safeSessionIdPattern = /^[A-Za-z0-9_-]+$/;
const safePaneIdPattern = /^[A-Za-z0-9_:.-]+$/;

export function isSafeSessionId(value) {
  return typeof value === 'string' && safeSessionIdPattern.test(value);
}

export function isSafePaneId(value) {
  return typeof value === 'string' && safePaneIdPattern.test(value) && !value.includes('..');
}

export function parseContextJson(text) {
  if (typeof text !== 'string' || text === '') {
    return {};
  }
  return parseJsonLine(text) ?? {};
}

export function encodeProjectDirectoryName(cwd) {
  return cwd.replaceAll('/', '-');
}

// Fedora Atomic（Bazzite）的 /home 實際在 /var/home：herdr 回報的 cwd 與 Claude Code 記錄的 cwd 可能是不同寫法
export function getCwdVariants(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    return [];
  }
  const variants = [cwd];
  try {
    variants.push(fs.realpathSync(cwd));
  } catch {
    // cwd 不存在時只用原字串
  }
  for (const variant of [...variants]) {
    if (variant.startsWith('/var/home/')) {
      variants.push(variant.slice('/var'.length));
    } else if (variant.startsWith('/home/')) {
      variants.push(`/var${variant}`);
    }
  }
  return [...new Set(variants)];
}

export function getCandidateProjectDirectories(projectsDirectory, cwd) {
  const names = [];
  for (const variant of getCwdVariants(cwd)) {
    names.push(encodeProjectDirectoryName(variant));
    // 未驗證：Claude Code 可能把 `.` 等非英數字元也換成 `-`，多試一種寫法不影響正確路徑
    names.push(variant.replace(/[^A-Za-z0-9]/g, '-'));
  }
  return [...new Set(names)].map((name) => path.join(projectsDirectory, name));
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function findTranscriptBySessionId({ projectsDirectory, sessionId, cwds = [] }) {
  if (!isSafeSessionId(sessionId)) {
    return null;
  }
  const fileName = `${sessionId}.jsonl`;
  for (const cwd of cwds) {
    for (const directory of getCandidateProjectDirectories(projectsDirectory, cwd)) {
      const candidate = path.join(directory, fileName);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  let projectNames = [];
  try {
    projectNames = fs.readdirSync(projectsDirectory);
  } catch {
    return null;
  }
  for (const projectName of projectNames) {
    const candidate = path.join(projectsDirectory, projectName, fileName);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findLatestTranscript({ projectsDirectory, cwd }) {
  let latest = null;
  for (const directory of getCandidateProjectDirectories(projectsDirectory, cwd)) {
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      let modifiedMs;
      try {
        modifiedMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (latest === null || modifiedMs > latest.modifiedMs) {
        latest = { filePath, modifiedMs };
      }
    }
  }
  return latest?.filePath ?? null;
}

// 非同步執行：herdr 卡住時 event loop 還要能處理 q／Esc；signal abort 或逾時都會 kill 子程序
export function runHerdrCommand(herdrBinPath, argumentList, { signal, timeoutMs = herdrTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(herdrBinPath, argumentList, { encoding: 'utf8', timeout: timeoutMs, signal }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
    // execFile 的 stdin 是 pipe（原本 execFileSync 用 ignore）：不關掉的話，指令若讀 stdin 會卡到逾時
    child.stdin?.end();
  });
}

// 不要用 error.message：execFile 的 message 會帶整行指令與 herdr 的 stderr，多行又長
function describeCommandError(error) {
  if (error.killed && error.name !== 'AbortError') {
    return 'timed out';
  }
  return String(error.code ?? error.signal ?? error.message);
}

export async function readHerdrPane({ herdrBinPath, paneId, runCommand = runHerdrCommand, signal }) {
  let output;
  try {
    output = await runCommand(herdrBinPath, ['pane', 'get', paneId], { signal });
  } catch (error) {
    return { pane: null, note: `herdr pane get failed (${describeCommandError(error)})` };
  }
  const response = parseJsonLine(String(output));
  const pane = response?.result?.pane;
  if (pane === null || typeof pane !== 'object') {
    return { pane: null, note: 'herdr pane get returned no pane' };
  }
  return { pane, note: null };
}

export function readPaneMappingFile({ runtimeDirectory, paneId }) {
  if (typeof runtimeDirectory !== 'string' || runtimeDirectory === '') {
    return { mapping: null, note: 'XDG_RUNTIME_DIR is not set' };
  }
  const filePath = path.join(runtimeDirectory, 'subagent-watch', `pane-${paneId}.json`);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { mapping: null, note: `no pane map at ${filePath}` };
  }
  const mapping = parseJsonLine(text);
  if (mapping === null) {
    return { mapping: null, note: `unreadable pane map at ${filePath}` };
  }
  return { mapping, note: null };
}

function expectedTranscriptPath(projectsDirectory, sessionId, cwds) {
  if (!isSafeSessionId(sessionId)) {
    return null;
  }
  for (const cwd of cwds) {
    const [directory] = getCandidateProjectDirectories(projectsDirectory, cwd);
    if (directory !== undefined) {
      return path.join(directory, `${sessionId}.jsonl`);
    }
  }
  return null;
}

function resolveFromSessionId({ projectsDirectory, sessionId, cwds, source }) {
  const transcriptPath = findTranscriptBySessionId({ projectsDirectory, sessionId, cwds });
  if (transcriptPath !== null) {
    return { transcriptPath, sessionId, source, isGuessed: false, isTranscriptMissing: false };
  }
  // session 剛開、還沒寫出第一行時 transcript 不存在；不能退回猜最新的，那會顯示上一個 session
  const expectedPath = expectedTranscriptPath(projectsDirectory, sessionId, cwds);
  if (expectedPath === null) {
    return null;
  }
  return { transcriptPath: expectedPath, sessionId, source, isGuessed: false, isTranscriptMissing: true };
}

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value !== '') ?? null;
}

// herdr 的 agent 偵測結果（pane 的 `agent`）：純 shell 沒有這個 key，其他 agent 是名稱（實測 0.9.3：`"codex"`）
export function getDetectedAgent(pane) {
  if (pane === null || typeof pane !== 'object') {
    return null;
  }
  const agent = sanitizeText(pane.agent);
  return agent === '' ? null : truncateWithEllipsis(agent, maximumAgentNameWidth);
}

export function describeNonClaudePane(nonClaudePane) {
  if (nonClaudePane.detectedAgent === null) {
    return noAgentPaneMessage;
  }
  return `This pane is not running Claude Code (detected: ${nonClaudePane.detectedAgent})`;
}

// 重問的結果不一定比現在的好：herdr 暫時失敗時會退回猜測或找不到，不能因此換掉已經確定的 session 或把畫面清空
// 換 session 的情況：現在沒有 session、現在是猜的，或新的結果是確定的（herdr／pane map 回報了別的 session id）
export function shouldReplaceSession(current, next) {
  if (current === null || current.transcriptPath === null) {
    return true;
  }
  if (next.transcriptPath === null) {
    return false;
  }
  return current.isGuessed || !next.isGuessed;
}

// signal：viewer 結束時 abort，正在跑的 herdr 子程序跟著被 kill
export async function resolveSession({
  paneId = null,
  contextCwd = null,
  fallbackCwd = null,
  projectsDirectory = getClaudeProjectsDirectory(),
  runtimeDirectory = process.env.XDG_RUNTIME_DIR,
  herdrBinPath = resolveHerdrBinPath(),
  runCommand = runHerdrCommand,
  signal,
}) {
  const notes = [];
  // notes 會原樣畫到畫面上，內容含 herdr 回報的值、env 給的路徑，一律先 sanitize
  const addNote = (note) => {
    notes.push(sanitizeText(note));
  };
  const usablePaneId = isSafePaneId(paneId) ? paneId : null;
  if (paneId !== null && usablePaneId === null) {
    addNote(`ignored unsafe pane id ${JSON.stringify(paneId)}`);
  }
  let pane = null;
  let mapping = null;

  if (usablePaneId !== null) {
    const herdrResult = herdrBinPath === null
      ? { pane: null, note: herdrNotFoundMessage }
      : await readHerdrPane({ herdrBinPath, paneId: usablePaneId, runCommand, signal });
    pane = herdrResult.pane;
    if (herdrResult.note !== null) {
      addNote(herdrResult.note);
    }
    // herdr 明確說這個 pane 沒跑 Claude Code 時不能往下猜：cwd 最新的 session 一定是別的 pane 的
    const detectedAgent = getDetectedAgent(pane);
    if (pane !== null && detectedAgent !== 'claude') {
      return {
        transcriptPath: null,
        sessionId: null,
        source: 'herdr',
        isGuessed: false,
        isTranscriptMissing: true,
        nonClaudePane: { detectedAgent },
        notes,
      };
    }
    const agentSession = pane?.agent_session;
    const isClaudeSession = agentSession?.agent === undefined || agentSession.agent === 'claude';
    if (agentSession && isClaudeSession && typeof agentSession.value === 'string') {
      const cwds = [pane.foreground_cwd, pane.cwd, contextCwd].filter(Boolean);
      if (agentSession.value.endsWith('.jsonl') && path.isAbsolute(agentSession.value)) {
        return {
          transcriptPath: agentSession.value,
          sessionId: path.basename(agentSession.value, '.jsonl'),
          source: 'herdr',
          isGuessed: false,
          isTranscriptMissing: !isFile(agentSession.value),
          notes,
        };
      }
      const resolved = resolveFromSessionId({ projectsDirectory, sessionId: agentSession.value, cwds, source: 'herdr' });
      if (resolved !== null) {
        return { ...resolved, notes };
      }
      addNote(`herdr reported session ${agentSession.value} but no project folder matched`);
    } else if (pane !== null) {
      addNote(`herdr pane ${usablePaneId} has no claude agent_session`);
    }

    const mappingResult = readPaneMappingFile({ runtimeDirectory, paneId: usablePaneId });
    mapping = mappingResult.mapping;
    if (mappingResult.note !== null) {
      addNote(mappingResult.note);
    }
    if (mapping !== null) {
      if (typeof mapping.transcriptPath === 'string' && path.isAbsolute(mapping.transcriptPath) && isFile(mapping.transcriptPath)) {
        return {
          transcriptPath: mapping.transcriptPath,
          sessionId: path.basename(mapping.transcriptPath, '.jsonl'),
          source: 'pane-map',
          isGuessed: false,
          isTranscriptMissing: false,
          notes,
        };
      }
      if (isSafeSessionId(mapping.sessionId)) {
        const cwds = [mapping.cwd, pane?.foreground_cwd, pane?.cwd, contextCwd].filter(Boolean);
        const resolved = resolveFromSessionId({ projectsDirectory, sessionId: mapping.sessionId, cwds, source: 'pane-map' });
        if (resolved !== null) {
          return { ...resolved, notes };
        }
      }
      addNote('pane map has no usable sessionId or transcriptPath');
    }
  } else {
    addNote('no pane id available');
  }

  const cwd = pickString(pane?.foreground_cwd, pane?.cwd, contextCwd, mapping?.cwd, fallbackCwd);
  if (cwd === null) {
    addNote('no cwd available to guess a session');
    return { transcriptPath: null, sessionId: null, source: null, isGuessed: false, isTranscriptMissing: true, notes };
  }
  const latestPath = findLatestTranscript({ projectsDirectory, cwd });
  if (latestPath === null) {
    addNote(`no transcripts found for cwd ${cwd}`);
    return { transcriptPath: null, sessionId: null, source: null, isGuessed: false, isTranscriptMissing: true, notes };
  }
  return {
    transcriptPath: latestPath,
    sessionId: path.basename(latestPath, '.jsonl'),
    source: 'guessed',
    isGuessed: true,
    isTranscriptMissing: false,
    notes,
  };
}
