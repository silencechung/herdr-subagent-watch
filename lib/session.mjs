import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonLine } from './transcript.mjs';

export const defaultHerdrBinPath = '/opt/herdr/bin/herdr';
export const defaultProjectsDirectory = path.join(os.homedir(), '.claude', 'projects');

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

export function runHerdrCommand(herdrBinPath, args) {
  return execFileSync(herdrBinPath, args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function readHerdrPane({ herdrBinPath, paneId, runCommand = runHerdrCommand }) {
  let output;
  try {
    output = runCommand(herdrBinPath, ['pane', 'get', paneId]);
  } catch (error) {
    return { pane: null, note: `herdr pane get failed (${error.code ?? error.message})` };
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

export function resolveSession({
  paneId = null,
  contextCwd = null,
  fallbackCwd = null,
  projectsDirectory = defaultProjectsDirectory,
  runtimeDirectory = process.env.XDG_RUNTIME_DIR,
  herdrBinPath = defaultHerdrBinPath,
  runCommand = runHerdrCommand,
}) {
  const notes = [];
  const usablePaneId = isSafePaneId(paneId) ? paneId : null;
  if (paneId !== null && usablePaneId === null) {
    notes.push(`ignored unsafe pane id ${JSON.stringify(paneId)}`);
  }
  let pane = null;
  let mapping = null;

  if (usablePaneId !== null) {
    const herdrResult = readHerdrPane({ herdrBinPath, paneId: usablePaneId, runCommand });
    pane = herdrResult.pane;
    if (herdrResult.note !== null) {
      notes.push(herdrResult.note);
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
      notes.push(`herdr reported session ${agentSession.value} but no project folder matched`);
    } else if (pane !== null) {
      notes.push(`herdr pane ${usablePaneId} has no claude agent_session`);
    }

    const mappingResult = readPaneMappingFile({ runtimeDirectory, paneId: usablePaneId });
    mapping = mappingResult.mapping;
    if (mappingResult.note !== null) {
      notes.push(mappingResult.note);
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
      notes.push('pane map has no usable sessionId or transcriptPath');
    }
  } else {
    notes.push('no pane id available');
  }

  const cwd = pickString(pane?.foreground_cwd, pane?.cwd, contextCwd, mapping?.cwd, fallbackCwd);
  if (cwd === null) {
    notes.push('no cwd available to guess a session');
    return { transcriptPath: null, sessionId: null, source: null, isGuessed: false, isTranscriptMissing: true, notes };
  }
  const latestPath = findLatestTranscript({ projectsDirectory, cwd });
  if (latestPath === null) {
    notes.push(`no transcripts found for cwd ${cwd}`);
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
