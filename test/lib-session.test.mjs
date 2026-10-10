import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  describeNonClaudePane,
  encodeProjectDirectoryName,
  findLatestTranscript,
  getCwdVariants,
  isSafePaneId,
  isSafeSessionId,
  resolveSession,
  runHerdrCommand,
  shouldReplaceSession,
} from '../lib/session.mjs';

const herdrFixtureDirectory = fileURLToPath(new URL('./fixtures/herdr/', import.meta.url));

// herdr 0.9.3 實際的 `pane get` 輸出（路徑、標題換成假的）
function readPaneFixture(name, overrides = {}) {
  const response = JSON.parse(fs.readFileSync(path.join(herdrFixtureDirectory, name), 'utf8'));
  return { ...response.result.pane, ...overrides };
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-session-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

let caseCounter = 0;

function createCase() {
  caseCounter += 1;
  const caseDirectory = path.join(temporaryRoot, `case-${caseCounter}`);
  const projectsDirectory = path.join(caseDirectory, 'projects');
  const runtimeDirectory = path.join(caseDirectory, 'runtime');
  fs.mkdirSync(projectsDirectory, { recursive: true });
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  return { caseDirectory, projectsDirectory, runtimeDirectory };
}

function writeTranscript(projectsDirectory, cwd, sessionId, modifiedMs = Date.now()) {
  const directory = path.join(projectsDirectory, encodeProjectDirectoryName(cwd));
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, '{"type":"user"}\n');
  const modifiedDate = new Date(modifiedMs);
  fs.utimesSync(filePath, modifiedDate, modifiedDate);
  return filePath;
}

function herdrReturning(pane) {
  const calls = [];
  const runCommand = (binPath, argumentList) => {
    calls.push([binPath, ...argumentList]);
    return JSON.stringify({ id: 'cli:pane:get', result: { pane, type: 'pane_info' } });
  };
  return { runCommand, calls };
}

function herdrFailing() {
  return () => {
    const error = new Error('connect failed');
    error.code = 'ECONNREFUSED';
    throw error;
  };
}

test('encodeProjectDirectoryName replaces slashes with dashes', () => {
  assert.equal(encodeProjectDirectoryName('/var/home/someone'), '-var-home-someone');
});

test('getCwdVariants adds the other spelling of a Fedora Atomic home path', () => {
  const variants = getCwdVariants('/var/home/nobody-here/project');
  assert.ok(variants.includes('/var/home/nobody-here/project'));
  assert.ok(variants.includes('/home/nobody-here/project'));
  assert.deepEqual(getCwdVariants('relative/path'), []);
});

test('unsafe pane ids and session ids are rejected before touching the file system', () => {
  assert.equal(isSafePaneId('w8:pV'), true);
  assert.equal(isSafePaneId('../etc'), false);
  assert.equal(isSafePaneId('a/b'), false);
  assert.equal(isSafeSessionId('aaab440d-4328-4037-9d11-132098a653a6'), true);
  assert.equal(isSafeSessionId('../../x'), false);
});

test('path a: herdr agent_session id resolves to the transcript in any project folder', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const sessionId = 'aaaa1111-0000-4000-8000-000000000001';
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/elsewhere', sessionId);
  writeTranscript(projectsDirectory, '/srv/work', 'bbbb2222-0000-4000-8000-000000000002', Date.now() + 10_000);
  const { runCommand, calls } = herdrReturning({
    pane_id: 'w1:p1',
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: sessionId },
    cwd: '/srv/work',
    foreground_cwd: '/srv/work',
  });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.source, 'herdr');
  assert.equal(result.isGuessed, false);
  assert.deepEqual(calls, [['/fake/herdr', 'pane', 'get', 'w1:p1']]);
});

test('path a: a reported session without a transcript yet waits instead of guessing an older session', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'old00000-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning({
    pane_id: 'w1:p1',
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', value: 'new00000-0000-4000-8000-000000000000' },
    foreground_cwd: '/srv/work',
  });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.isTranscriptMissing, true);
  assert.equal(result.isGuessed, false);
  assert.equal(result.transcriptPath, path.join(projectsDirectory, '-srv-work', 'new00000-0000-4000-8000-000000000000.jsonl'));
});

test('path b: the pane map written by the hook is used when herdr has no session', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const sessionId = 'cccc3333-0000-4000-8000-000000000003';
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/mapped', sessionId);
  fs.mkdirSync(path.join(runtimeDirectory, 'subagent-watch'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, 'subagent-watch', 'pane-w2:p3.json'), JSON.stringify({
    sessionId,
    transcriptPath,
    cwd: '/srv/mapped',
    updatedAtMs: Date.now(),
  }));
  const { runCommand } = herdrReturning({ pane_id: 'w2:p3', agent: 'claude', cwd: '/srv/mapped' });
  const result = await resolveSession({ paneId: 'w2:p3', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.source, 'pane-map');
  assert.equal(result.isGuessed, false);
});

test('path b: a pane map with only sessionId is looked up by id', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const sessionId = 'dddd4444-0000-4000-8000-000000000004';
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/mapped', sessionId);
  fs.mkdirSync(path.join(runtimeDirectory, 'subagent-watch'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, 'subagent-watch', 'pane-w2:p4.json'), JSON.stringify({ sessionId, cwd: '/srv/mapped' }));
  const result = await resolveSession({ paneId: 'w2:p4', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrFailing() });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.source, 'pane-map');
});

test('path c: without herdr or pane map, the newest transcript for the pane cwd is guessed', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/guess', 'eeee5555-0000-4000-8000-000000000005', Date.now() - 60_000);
  const newestPath = writeTranscript(projectsDirectory, '/srv/guess', 'ffff6666-0000-4000-8000-000000000006', Date.now());
  writeTranscript(projectsDirectory, '/srv/other', 'abab7777-0000-4000-8000-000000000007', Date.now() + 60_000);
  const result = await resolveSession({
    paneId: 'w3:p1',
    contextCwd: '/srv/guess',
    projectsDirectory,
    runtimeDirectory,
    herdrBinPath: '/fake/herdr',
    runCommand: herdrFailing(),
  });
  assert.equal(result.transcriptPath, newestPath);
  assert.equal(result.source, 'guessed');
  assert.equal(result.isGuessed, true);
  assert.ok(result.notes.some((note) => note.includes('herdr pane get failed')));
  assert.ok(result.notes.some((note) => note.includes('no pane map')));
});

test('path c ignores sub folders and non-jsonl files when picking the newest transcript', () => {
  const { projectsDirectory } = createCase();
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/mixed', 'acac8888-0000-4000-8000-000000000008', Date.now() - 1_000);
  const projectDirectory = path.dirname(transcriptPath);
  fs.mkdirSync(path.join(projectDirectory, 'acac8888-0000-4000-8000-000000000008', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projectDirectory, 'notes.txt'), 'x');
  assert.equal(findLatestTranscript({ projectsDirectory, cwd: '/srv/mixed' }), transcriptPath);
});

test('a pane where herdr detects another agent says so and does not guess a session', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'abcd0000-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-codex.json'));
  const result = await resolveSession({ paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, null);
  assert.equal(result.isGuessed, false);
  assert.equal(result.isTranscriptMissing, true);
  assert.deepEqual(result.nonClaudePane, { detectedAgent: 'codex' });
  assert.equal(describeNonClaudePane(result.nonClaudePane), 'This pane is not running Claude Code (detected: codex)');
});

test('a plain shell pane (no agent key) says there is no Claude Code session and does not guess', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'abcd1111-0000-4000-8000-000000000000');
  fs.mkdirSync(path.join(runtimeDirectory, 'subagent-watch'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, 'subagent-watch', 'pane-w1:p1.json'), JSON.stringify({ sessionId: 'abcd1111-0000-4000-8000-000000000000', cwd: '/srv/work' }));
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-shell.json'));
  const result = await resolveSession({ paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, null);
  assert.equal(result.isGuessed, false);
  assert.deepEqual(result.nonClaudePane, { detectedAgent: null });
  assert.equal(describeNonClaudePane(result.nonClaudePane), 'No Claude Code session in this pane');
});

test('herdr detection wins over a leftover claude agent_session on a pane now running another agent', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-codex.json', {
    agent_session: { agent: 'claude', kind: 'id', value: 'abcd2222-0000-4000-8000-000000000000' },
  }));
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.deepEqual(result.nonClaudePane, { detectedAgent: 'codex' });
});

test('the real claude pane shape resolves through agent_session', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const pane = readPaneFixture('pane-get-claude.json');
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/work', pane.agent_session.value);
  const { runCommand } = herdrReturning(pane);
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.source, 'herdr');
  assert.equal(result.nonClaudePane, undefined);
});

test('a claude pane without agent_session still falls back to the pane map, then the cwd guess', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const newestPath = writeTranscript(projectsDirectory, '/srv/work', 'abcd3333-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-claude-without-session.json'));
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, newestPath);
  assert.equal(result.isGuessed, true);
  assert.ok(result.notes.some((note) => note.includes('has no claude agent_session')));
});

test('without a herdr binary the viewer falls back to guessing and says why', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const newestPath = writeTranscript(projectsDirectory, '/srv/nobin', 'abcd4444-0000-4000-8000-000000000000');
  const result = await resolveSession({ paneId: 'w1:p1', contextCwd: '/srv/nobin', projectsDirectory, runtimeDirectory, herdrBinPath: null });
  assert.equal(result.transcriptPath, newestPath);
  assert.equal(result.isGuessed, true);
  assert.ok(result.notes.some((note) => note.startsWith('herdr not found')));
});

test('detected agent names are cleaned before they reach the screen', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const { runCommand } = herdrReturning({ pane_id: 'w1:p1', agent: 'evil\u001b[31m\nagent' });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.doesNotMatch(result.nonClaudePane.detectedAgent, /[\u0000-\u001f]/);
});

test('nothing to go on yields an unresolved result with notes instead of throwing', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const result = await resolveSession({ paneId: null, projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrFailing() });
  assert.equal(result.transcriptPath, null);
  assert.ok(result.notes.includes('no pane id available'));
});

// 外來字串進 notes 前要剝掉 ESC／C1／bidi：notes 會原樣畫在 popup 上
const terminalControlPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

test('notes built from herdr values, pane ids and cwds carry no terminal escapes', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const { runCommand } = herdrReturning({
    pane_id: 'w1:p1',
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', value: 'evil\u001b]52;c;cHduZWQ=\u0007\u009b2J\u202eid' },
    foreground_cwd: '/srv/x\u001b]8;;https://evil.example/\u001b\\link',
  });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  // 不合格的 session id 不能拼成「等它出現」的路徑
  assert.equal(result.transcriptPath, null);
  assert.ok(result.notes.some((note) => note.startsWith('herdr reported session evil')));
  assert.ok(result.notes.some((note) => note.startsWith('no transcripts found for cwd /srv/x')));
  for (const note of result.notes) {
    assert.doesNotMatch(note, terminalControlPattern, JSON.stringify(note));
  }

  const unsafe = await resolveSession({ paneId: '../\u009b31m\u001b[2J', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.ok(unsafe.notes[0].startsWith('ignored unsafe pane id'));
  for (const note of unsafe.notes) {
    assert.doesNotMatch(note, terminalControlPattern, JSON.stringify(note));
  }
});

test('resolveSession hands its abort signal to the herdr command', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const abortController = new AbortController();
  let receivedSignal = null;
  const runCommand = (binPath, argumentList, { signal }) => {
    receivedSignal = signal;
    return JSON.stringify({ result: { pane: { agent: 'codex' } } });
  };
  await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand, signal: abortController.signal });
  assert.equal(receivedSignal, abortController.signal);
});

test('shouldReplaceSession switches to a new session but never downgrades to a guess or to nothing', () => {
  const herdrA = { transcriptPath: '/p/a.jsonl', isGuessed: false };
  const herdrB = { transcriptPath: '/p/b.jsonl', isGuessed: false };
  const guessedC = { transcriptPath: '/p/c.jsonl', isGuessed: true };
  const guessedD = { transcriptPath: '/p/d.jsonl', isGuessed: true };
  const unresolved = { transcriptPath: null, isGuessed: false };
  assert.equal(shouldReplaceSession(null, unresolved), true);
  assert.equal(shouldReplaceSession(unresolved, unresolved), true);
  assert.equal(shouldReplaceSession(unresolved, guessedC), true);
  // /resume、重開 claude：herdr 回報另一個 session id
  assert.equal(shouldReplaceSession(herdrA, herdrB), true);
  // 猜的被確定的取代，猜的也跟著最新的換
  assert.equal(shouldReplaceSession(guessedC, herdrA), true);
  assert.equal(shouldReplaceSession(guessedC, guessedD), true);
  // herdr 暫時失敗退回猜測或找不到時，留著已經確定的 session
  assert.equal(shouldReplaceSession(herdrA, guessedC), false);
  assert.equal(shouldReplaceSession(herdrA, unresolved), false);
});

function writeExecutable(name, body) {
  const filePath = path.join(temporaryRoot, name);
  fs.writeFileSync(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return filePath;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('runHerdrCommand runs asynchronously and returns stdout', async () => {
  const herdrPath = writeExecutable('herdr-echo', 'printf "%s|" "$@"');
  let isSettled = false;
  const pending = runHerdrCommand(herdrPath, ['pane', 'get', 'w1:p1']).finally(() => {
    isSettled = true;
  });
  assert.equal(isSettled, false);
  assert.equal(await pending, 'pane|get|w1:p1|');
});

test('runHerdrCommand closes stdin so a command that reads it does not hang', async () => {
  const herdrPath = writeExecutable('herdr-stdin', 'cat >/dev/null; echo done');
  assert.equal(await runHerdrCommand(herdrPath, [], { timeoutMs: 2000 }), 'done\n');
});

test('a stuck herdr times out, is killed and reported as timed out', async () => {
  const pidPath = path.join(temporaryRoot, 'herdr-stuck.pid');
  const herdrPath = writeExecutable('herdr-stuck', `echo $$ > '${pidPath}'; exec sleep 30`);
  const startMs = Date.now();
  const result = await readHerdrPaneWith(herdrPath, (binPath, argumentList, options) => runHerdrCommand(binPath, argumentList, { ...options, timeoutMs: 300 }));
  assert.ok(Date.now() - startMs < 2000, `took ${Date.now() - startMs} ms`);
  assert.equal(result.note, 'herdr pane get failed (timed out)');
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  await waitUntil(() => !isProcessAlive(pid), 'stuck herdr to be killed');
});

test('aborting the signal kills a running herdr right away', async () => {
  const pidPath = path.join(temporaryRoot, 'herdr-abort.pid');
  const herdrPath = writeExecutable('herdr-abort', `echo $$ > '${pidPath}'; exec sleep 30`);
  const abortController = new AbortController();
  const pending = runHerdrCommand(herdrPath, [], { signal: abortController.signal });
  await waitUntil(() => fs.existsSync(pidPath) && fs.readFileSync(pidPath, 'utf8').trim() !== '', 'herdr to start');
  abortController.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const pid = Number(fs.readFileSync(pidPath, 'utf8'));
  await waitUntil(() => !isProcessAlive(pid), 'aborted herdr to be killed');
});

async function readHerdrPaneWith(herdrBinPath, runCommand) {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath, runCommand });
  return { note: result.notes.find((note) => note.startsWith('herdr pane get')) };
}

async function waitUntil(predicate, description, timeoutMs = 3000) {
  const startMs = Date.now();
  while (!predicate()) {
    if (Date.now() - startMs > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}
