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

// 不存在（或不是檔案）時回傳 null
export function readTranscriptModifiedMs(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
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

// hook 收到這個 session 的 SessionStart 時才寫 sessionStartSource（值是 startup／resume／clear／compact 等）
function hasSessionStartMark(mapping) {
  return typeof mapping?.sessionStartSource === 'string' && mapping.sessionStartSource !== '';
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

const paneSourceKeys = ['herdr', 'paneMap'];

// 這次查詢各來源回報的 sessionId；查詢失敗、沒有可用的值、transcript 還不存在都是 null
// transcript 還不存在的不算回報：lastSeen 不記它，等 transcript 出現時仍然算「值變了」，herdr 在新 session 寫第一行前就回報時才換得過去
function getReportedSessionIds(session) {
  const reported = { herdr: null, paneMap: null };
  for (const key of paneSourceKeys) {
    const candidate = session?.paneCandidates?.[key] ?? null;
    if (candidate !== null && !candidate.isTranscriptMissing && typeof candidate.sessionId === 'string') {
      reported[key] = candidate.sessionId;
    }
  }
  return reported;
}

// 值變了的來源裡 transcript 寫得最近的候選（同時間取 herdr）；沒有就回傳 null
// 來源第一次有值（lastSeen 是 null，例：herdr 一開始失敗後來恢復）分不出是新的還是本來就過期：只有 transcript 比 current 新才算
function findChangedCandidate(current, currentModifiedMs, next, { lastSeenSessionIds, reported, getModifiedMs }) {
  let newest = null;
  let newestModifiedMs = null;
  for (const key of paneSourceKeys) {
    const sessionId = reported[key];
    const lastSeen = lastSeenSessionIds?.[key] ?? null;
    if (sessionId === null || sessionId === lastSeen) {
      continue;
    }
    const candidate = next.paneCandidates[key];
    const modifiedMs = candidate.transcriptPath === current.transcriptPath ? currentModifiedMs : getModifiedMs(candidate.transcriptPath);
    if (modifiedMs === null || (lastSeen === null && modifiedMs <= currentModifiedMs)) {
      continue;
    }
    if (newest === null || modifiedMs > newestModifiedMs) {
      newest = candidate;
      newestModifiedMs = modifiedMs;
    }
  }
  return newest;
}

function pickSessionToShow(current, next, options) {
  // SessionStart 寫的 pane map（resolveSession 已經選它）：session 一開始就寫、同一個 session 的 sub 事件不會拿掉標記，不需要再跟 herdr 比或看 mtime
  if (next.isSessionStart === true && !next.isTranscriptMissing && next.transcriptPath !== null) {
    return next;
  }
  if (current === null || current.transcriptPath === null) {
    return next;
  }
  if (next.transcriptPath === null) {
    return current;
  }
  const { getModifiedMs } = options;
  const isSameTranscript = next.transcriptPath === current.transcriptPath;
  if (next.isGuessed) {
    if (!current.isGuessed) {
      return current;
    }
    return isSameTranscript || getModifiedMs(current.transcriptPath) === null ? next : current;
  }
  if (current.isGuessed) {
    return next;
  }
  const currentModifiedMs = getModifiedMs(current.transcriptPath);
  if (currentModifiedMs === null) {
    return next;
  }
  const changed = findChangedCandidate(current, currentModifiedMs, next, options);
  if (changed !== null && changed.transcriptPath !== current.transcriptPath) {
    // 要換的就是 next 本身時回傳 next：shouldReplaceSession 靠物件相同判斷
    if (changed.transcriptPath === next.transcriptPath) {
      return next;
    }
    return { ...changed, statusNote: next.statusNote ?? null, notes: next.notes ?? [], paneCandidates: next.paneCandidates };
  }
  // 同一個 transcript：換成 next 只更新 isTranscriptMissing、statusNote 等，viewer 不會重建 tab
  return isSameTranscript ? next : current;
}

// pane map 帶 SessionStart 標記（sessionStartSource）而且 transcript 存在：直接用它，值變了就跟著換，不看 herdr 與 mtime。
// 沒有標記（舊版安裝、setup 之前就開的 session，或 pane map 被沒收到 SessionStart 的 session 蓋過）時，herdr 與 pane map 都可能過期，而且過期的值不會自己變回正確的：
// - herdr 的 agent_session：實測 herdr server 重啟後還原舊值；同一個 pane 開新的 claude、外部 report 都不會更新它（原因未知）
// - 沒有標記的 pane map：只在 SubagentStart／Stop 時寫，/resume 或開新 session 之後、開第一個 sub 之前都指向舊 session
// 過期的值指向的 session 可能正被別的 pane 寫（`claude -c`／`--resume` 沿用同一個 session id），兩個 transcript 輪流領先 mtime：
// 每次查詢都照 mtime 選的話，每 2 秒來回切一次、清掉 tab 選取與捲動位置。所以 mtime 只用在初次選擇，之後看來源的值有沒有變：
// - 還沒有 current、current 沒有 transcript 或 transcript 不見了：直接用 next（resolveSession 照 mtime 選的）
// - 查不到（next 沒有 transcript）：留著 current
// - 猜的不取代 herdr／pane map 給的，同一個 transcript 也不行（標籤會變回 guessed）；herdr／pane map 給的一定取代猜的
// - 猜的換猜的：只有 current 的 transcript 不見了才換；同一個資料夾兩個 session 輪流寫時，照 mtime 換一樣會來回切
// - 兩個都不是猜的：某個來源這次查詢成功、回報的值和它的 lastSeen 不同、新值不是 current，才換過去
//   兩個來源同一輪都變了，取 transcript 寫得比較近的；查詢失敗不更新 lastSeen，恢復成同一個值不算變化
// 回傳 { session, lastSeenSessionIds }：session 是這次查詢後要顯示的（=== current 代表不換），lastSeenSessionIds 留給下一次
// lastSeenSessionIds 是呼叫端保存的狀態；沒傳時用 current 查到當時的回報
export function chooseSession(current, next, { lastSeenSessionIds = getReportedSessionIds(current), getModifiedMs = readTranscriptModifiedMs } = {}) {
  const reported = getReportedSessionIds(next);
  const nextLastSeenSessionIds = {};
  for (const key of paneSourceKeys) {
    nextLastSeenSessionIds[key] = reported[key] ?? lastSeenSessionIds?.[key] ?? null;
  }
  return {
    session: pickSessionToShow(current, next, { lastSeenSessionIds, reported, getModifiedMs }),
    lastSeenSessionIds: nextLastSeenSessionIds,
  };
}

// 不保存 lastSeen 的呼叫端用，只回答 next 本身要不要取代 current
// 要換到 next 以外的候選時（例：pane map 的值變了，但 next 是照 mtime 選到的 herdr）回傳 false；viewer 用 chooseSession
export function shouldReplaceSession(current, next, options = {}) {
  return chooseSession(current, next, options).session === next;
}

function shortSessionId(sessionId) {
  return sanitizeText(sessionId).slice(0, 8);
}

// 初次選擇用（之後換不換由 chooseSession 決定）：herdr 與 pane map 是「這個 pane 專屬」的兩個候選，沒有歷史可比
// transcript 存在的，取最近寫入的那個（同時間取 herdr）：過期的值通常指向沒人在寫的舊 session
// 它若正被別的 pane 寫，這裡可能選錯，要等來源回報新值才會換（docs/internals.md 已知限制）
// 兩個的 transcript 都還不存在時才用 herdr（其次 pane map）回報的 session 等它出現，不退回去猜
function pickPaneCandidate(herdrCandidate, paneMapCandidate) {
  let newest = null;
  let newestModifiedMs = null;
  for (const candidate of [herdrCandidate, paneMapCandidate]) {
    if (candidate === null) {
      continue;
    }
    const modifiedMs = readTranscriptModifiedMs(candidate.transcriptPath);
    if (modifiedMs !== null && (newestModifiedMs === null || modifiedMs > newestModifiedMs)) {
      newest = candidate;
      newestModifiedMs = modifiedMs;
    }
  }
  if (newest !== null) {
    return { ...newest, isTranscriptMissing: false };
  }
  const waiting = herdrCandidate ?? paneMapCandidate;
  return waiting === null ? null : { ...waiting, isTranscriptMissing: true };
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
    // herdr 回報了 session 也要讀 pane map：herdr 可能過期（見 chooseSession），兩個候選都帶回去給 chooseSession 看值有沒有變
    let herdrCandidate = null;
    const agentSession = pane?.agent_session;
    const isClaudeSession = agentSession?.agent === undefined || agentSession.agent === 'claude';
    if (agentSession && isClaudeSession && typeof agentSession.value === 'string') {
      const cwds = [pane.foreground_cwd, pane.cwd, contextCwd].filter(Boolean);
      if (agentSession.value.endsWith('.jsonl') && path.isAbsolute(agentSession.value)) {
        herdrCandidate = {
          transcriptPath: agentSession.value,
          sessionId: path.basename(agentSession.value, '.jsonl'),
          source: 'herdr',
          isGuessed: false,
          isTranscriptMissing: !isFile(agentSession.value),
        };
      } else {
        herdrCandidate = resolveFromSessionId({ projectsDirectory, sessionId: agentSession.value, cwds, source: 'herdr' });
        if (herdrCandidate === null) {
          addNote(`herdr reported session ${agentSession.value} but no project folder matched`);
        }
      }
    } else if (pane !== null) {
      addNote(`herdr pane ${usablePaneId} has no claude agent_session`);
    }

    let paneMapCandidate = null;
    const mappingResult = readPaneMappingFile({ runtimeDirectory, paneId: usablePaneId });
    mapping = mappingResult.mapping;
    if (mappingResult.note !== null) {
      addNote(mappingResult.note);
    }
    if (mapping !== null) {
      if (typeof mapping.transcriptPath === 'string' && path.isAbsolute(mapping.transcriptPath) && isFile(mapping.transcriptPath)) {
        paneMapCandidate = {
          transcriptPath: mapping.transcriptPath,
          sessionId: path.basename(mapping.transcriptPath, '.jsonl'),
          source: 'pane-map',
          isGuessed: false,
          isTranscriptMissing: false,
        };
      } else if (isSafeSessionId(mapping.sessionId)) {
        const cwds = [mapping.cwd, pane?.foreground_cwd, pane?.cwd, contextCwd].filter(Boolean);
        paneMapCandidate = resolveFromSessionId({ projectsDirectory, sessionId: mapping.sessionId, cwds, source: 'pane-map' });
      }
      if (paneMapCandidate === null) {
        addNote('pane map has no usable sessionId or transcriptPath');
      } else if (hasSessionStartMark(mapping)) {
        paneMapCandidate = { ...paneMapCandidate, isSessionStart: true };
      }
    }

    // SessionStart 寫的 pane map 是這個 pane 現在的 session（hook 端見 hooks/sidebar-hook.mjs 的 buildPaneMap），transcript 在就不跟 herdr 比 mtime；
    // transcript 還不存在（session 剛開、還沒寫第一行）時照舊在兩個來源之間挑
    const chosen = paneMapCandidate?.isSessionStart === true && !paneMapCandidate.isTranscriptMissing
      ? paneMapCandidate
      : pickPaneCandidate(herdrCandidate, paneMapCandidate);
    if (chosen !== null) {
      // 兩邊說法不同時留一行給畫面的狀態列，看得出是哪一邊過期
      let statusNote = null;
      if (herdrCandidate !== null && paneMapCandidate !== null && herdrCandidate.transcriptPath !== paneMapCandidate.transcriptPath) {
        addNote(`herdr says session ${shortSessionId(herdrCandidate.sessionId)}, pane map says ${shortSessionId(paneMapCandidate.sessionId)}`);
        statusNote = notes.at(-1);
      }
      return { ...chosen, statusNote, notes, paneCandidates: { herdr: herdrCandidate, paneMap: paneMapCandidate } };
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
