import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  chooseSession,
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

// resolveSession 走 pane 那條路的結果：top-level 是照 mtime 選的候選，paneCandidates 是兩個來源各自回報的候選
function lookupResult(chosen, { herdr = null, paneMap = null } = {}) {
  return { ...chosen, statusNote: null, notes: [], paneCandidates: { herdr, paneMap } };
}

test('shouldReplaceSession switches only when a source reports a new session, and never downgrades to a guess or to nothing', () => {
  const { projectsDirectory } = createCase();
  const nowMs = Date.now();
  const session = (sessionId, source, modifiedMs) => ({
    transcriptPath: writeTranscript(projectsDirectory, '/srv/replace', sessionId, modifiedMs),
    sessionId,
    source,
    isGuessed: source === 'guessed',
    isTranscriptMissing: false,
  });
  const herdrOld = session('a0000000-0000-4000-8000-000000000001', 'herdr', nowMs - 60_000);
  const herdrNew = session('b0000000-0000-4000-8000-000000000002', 'herdr', nowMs);
  const paneMapOld = { ...herdrOld, source: 'pane-map' };
  const guessedC = session('c0000000-0000-4000-8000-000000000003', 'guessed', nowMs + 60_000);
  const guessedD = session('d0000000-0000-4000-8000-000000000004', 'guessed', nowMs + 120_000);
  const unresolved = { transcriptPath: null, sessionId: null, source: null, isGuessed: false };
  const fromHerdr = (candidate) => lookupResult(candidate, { herdr: candidate });
  const fromPaneMap = (candidate) => lookupResult(candidate, { paneMap: candidate });
  assert.equal(shouldReplaceSession(null, unresolved), true);
  assert.equal(shouldReplaceSession(unresolved, unresolved), true);
  assert.equal(shouldReplaceSession(unresolved, guessedC), true);
  // /resume、重開 claude：herdr 回報的值變了
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), fromHerdr(herdrNew)), true);
  // 值變了就換，不看 mtime：過期的 session 可能正被別的 pane 寫，mtime 分不出誰才是這個 pane 的
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr(herdrOld)), true);
  // herdr 逾時退回 pane map：pane map 第一次有值、transcript 比 current 舊，不換
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromPaneMap(paneMapOld)), false);
  // 兩個來源的值都沒變：next 照 mtime 選到另一個 transcript 也不換
  const bothSources = { herdr: herdrNew, paneMap: paneMapOld };
  assert.equal(shouldReplaceSession(lookupResult(herdrNew, bothSources), lookupResult(paneMapOld, bothSources)), false);
  // 同一個 transcript 換成新的結果（例 isTranscriptMissing、statusNote 變了）
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromPaneMap({ ...herdrNew, source: 'pane-map' })), true);
  // 猜的被 herdr／pane map 給的取代，就算猜的寫得比較近
  assert.equal(shouldReplaceSession(guessedC, fromPaneMap(paneMapOld)), true);
  // 猜的不能取代 herdr／pane map 給的，同一個 transcript 也不行
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), guessedC), false);
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), { ...herdrOld, source: 'guessed', isGuessed: true }), false);
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), unresolved), false);
  // 猜的換猜的：現在的 transcript 還在就不換，就算另一個寫得比較近
  assert.equal(shouldReplaceSession(guessedC, guessedD), false);
  // 同一個 session id 只是路徑不同：值沒變，不換
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr({ ...herdrNew, transcriptPath: '/elsewhere/x.jsonl' }), { getModifiedMs: () => nowMs }), false);

  fs.rmSync(guessedC.transcriptPath);
  fs.rmSync(herdrNew.transcriptPath);
  // 現在的 transcript 不見了：換成任何還在的 session
  assert.equal(shouldReplaceSession(guessedC, guessedD), true);
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromPaneMap(paneMapOld)), true);
});

// 照 viewer 的用法保存 current 與 lastSeen；switches 只算換到別的 transcript（viewer 會重建 tab、清掉選取與捲動位置）
function createSessionFollower() {
  const follower = {
    current: null,
    lastSeenSessionIds: undefined,
    switches: 0,
    offer(next) {
      const choice = chooseSession(follower.current, next, { lastSeenSessionIds: follower.lastSeenSessionIds });
      follower.lastSeenSessionIds = choice.lastSeenSessionIds;
      if (choice.session !== follower.current) {
        if (follower.current !== null && follower.current.transcriptPath !== choice.session.transcriptPath) {
          follower.switches += 1;
        }
        follower.current = choice.session;
      }
      return follower.current;
    },
  };
  return follower;
}

function touch(filePath, modifiedMs) {
  const modifiedDate = new Date(modifiedMs);
  fs.utimesSync(filePath, modifiedDate, modifiedDate);
}

function writePaneMap(runtimeDirectory, paneId, mapping) {
  fs.mkdirSync(path.join(runtimeDirectory, 'subagent-watch'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, 'subagent-watch', `pane-${paneId}.json`), JSON.stringify(mapping));
}

function herdrClaudePane(sessionValue, cwd = '/srv/work') {
  return { pane_id: 'w1:p1', agent: 'claude', agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: sessionValue }, cwd, foreground_cwd: cwd };
}

function herdrTimingOut() {
  return () => {
    const error = new Error('Command failed');
    error.killed = true;
    error.signal = 'SIGTERM';
    throw error;
  };
}

test('a stale herdr session loses to the pane map session whose transcript was written more recently', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  // 實測：herdr server 重啟後同一個 pane 開新的 claude，herdr 仍回報重啟前的 session
  const staleId = 'aaab440d-0000-4000-8000-000000000001';
  const currentId = '3cd69807-0000-4000-8000-000000000002';
  writeTranscript(projectsDirectory, '/srv/work', staleId, Date.now() - 3_600_000);
  const currentPath = writeTranscript(projectsDirectory, '/srv/work', currentId, Date.now());
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: currentId, transcriptPath: currentPath, cwd: '/srv/work', updatedAtMs: Date.now() });
  const { runCommand } = herdrReturning(herdrClaudePane(staleId));
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, currentPath);
  assert.equal(result.source, 'pane-map');
  assert.equal(result.isGuessed, false);
  assert.equal(result.statusNote, 'herdr says session aaab440d, pane map says 3cd69807');
  assert.ok(result.notes.includes(result.statusNote));
});

test('herdr wins over a pane map left over from before /resume, and agreeing sources leave no status note', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const oldId = 'a1a1a1a1-0000-4000-8000-000000000001';
  const newId = 'b2b2b2b2-0000-4000-8000-000000000002';
  const oldPath = writeTranscript(projectsDirectory, '/srv/work', oldId, Date.now() - 60_000);
  const newPath = writeTranscript(projectsDirectory, '/srv/work', newId, Date.now());
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: oldId, transcriptPath: oldPath, cwd: '/srv/work', updatedAtMs: 0 });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(result.transcriptPath, newPath);
  assert.equal(result.source, 'herdr');
  assert.equal(result.statusNote, 'herdr says session b2b2b2b2, pane map says a1a1a1a1');

  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: newId, transcriptPath: newPath, cwd: '/srv/work', updatedAtMs: 0 });
  const agreeing = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(agreeing.transcriptPath, newPath);
  assert.equal(agreeing.statusNote, null);
});

test('herdr timing out after /resume falls back to the old pane map, and the viewer keeps the newer session', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const oldId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const newId = 'bbbbbbbb-0000-4000-8000-000000000002';
  const oldPath = writeTranscript(projectsDirectory, '/srv/work', oldId, Date.now() - 60_000);
  const newPath = writeTranscript(projectsDirectory, '/srv/work', newId, Date.now());
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: oldId, transcriptPath: oldPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const current = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(current.transcriptPath, newPath);
  const duringTimeout = await resolveSession({ ...base, runCommand: herdrTimingOut() });
  assert.equal(duringTimeout.transcriptPath, oldPath);
  assert.ok(duringTimeout.notes.includes('herdr pane get failed (timed out)'));
  assert.equal(shouldReplaceSession(current, duringTimeout), false);
  const recovered = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(shouldReplaceSession(current, recovered), true);
  assert.equal(recovered.transcriptPath, current.transcriptPath);
});

test('a session herdr reports before its first write waits only when the pane map has nothing usable', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const previousId = 'c3c3c3c3-0000-4000-8000-000000000003';
  const startingId = 'd4d4d4d4-0000-4000-8000-000000000004';
  const previousPath = writeTranscript(projectsDirectory, '/srv/work', previousId, Date.now() - 60_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: previousId, transcriptPath: previousPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const beforeFirstWrite = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(startingId)).runCommand });
  assert.equal(beforeFirstWrite.transcriptPath, previousPath);
  assert.equal(beforeFirstWrite.isTranscriptMissing, false);
  const startingPath = writeTranscript(projectsDirectory, '/srv/work', startingId, Date.now());
  const afterFirstWrite = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(startingId)).runCommand });
  assert.equal(afterFirstWrite.transcriptPath, startingPath);
  assert.equal(shouldReplaceSession(beforeFirstWrite, afterFirstWrite), true);
});

test('with two sessions writing in turn in the same folder, a guessed session sticks until its transcript is gone', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const firstPath = writeTranscript(projectsDirectory, '/srv/shared', 'e5e5e5e5-0000-4000-8000-000000000005', Date.now() - 1_000);
  const secondPath = writeTranscript(projectsDirectory, '/srv/shared', 'f6f6f6f6-0000-4000-8000-000000000006', Date.now() - 2_000);
  const base = { paneId: null, fallbackCwd: '/srv/shared', projectsDirectory, runtimeDirectory, herdrBinPath: null };
  let current = await resolveSession(base);
  assert.equal(current.transcriptPath, firstPath);
  assert.equal(current.isGuessed, true);
  let switchCount = 0;
  for (let round = 1; round <= 6; round += 1) {
    const writtenDate = new Date(Date.now() + round * 1_000);
    fs.utimesSync(round % 2 === 1 ? secondPath : firstPath, writtenDate, writtenDate);
    const next = await resolveSession(base);
    if (shouldReplaceSession(current, next) && next.transcriptPath !== current.transcriptPath) {
      switchCount += 1;
      current = next;
    }
  }
  assert.equal(switchCount, 0);
  assert.equal(current.transcriptPath, firstPath);
  fs.rmSync(firstPath);
  const next = await resolveSession(base);
  assert.equal(next.transcriptPath, secondPath);
  assert.equal(shouldReplaceSession(current, next), true);
});

for (const staleSource of ['pane map', 'herdr']) {
  test(`a stale ${staleSource} naming a session another pane keeps writing does not make the viewer flap`, async () => {
    const { projectsDirectory, runtimeDirectory } = createCase();
    // 這個 pane 現在跑的是 ownId；過期的來源指向 otherId，它在別的 pane 被 \`claude -c\` 接著寫
    const ownId = 'bbbbbbbb-0000-4000-8000-000000000002';
    const otherId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const startMs = Date.now();
    const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, startMs);
    const otherPath = writeTranscript(projectsDirectory, '/srv/work', otherId, startMs - 1_000);
    const [herdrId, paneMapId, paneMapPath] = staleSource === 'pane map' ? [ownId, otherId, otherPath] : [otherId, ownId, ownPath];
    writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: paneMapId, transcriptPath: paneMapPath, cwd: '/srv/work', updatedAtMs: 0 });
    const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(herdrId)).runCommand };
    const follower = createSessionFollower();
    let statelessCurrent = null;
    let statelessSwitches = 0;
    for (let round = 0; round < 10; round += 1) {
      // 兩個 session 在兩次查詢之間輪流寫
      touch(round % 2 === 0 ? ownPath : otherPath, startMs + (round + 1) * 2_000);
      const next = await resolveSession(base);
      assert.equal(follower.offer(next).transcriptPath, ownPath, `round ${round}`);
      // 不保存 lastSeen 的用法（shouldReplaceSession）也一樣不能來回切
      if (shouldReplaceSession(statelessCurrent, next)) {
        if (statelessCurrent !== null && statelessCurrent.transcriptPath !== next.transcriptPath) {
          statelessSwitches += 1;
        }
        statelessCurrent = next;
      }
    }
    assert.equal(follower.switches, 0);
    assert.equal(statelessSwitches, 0);
    assert.equal(statelessCurrent.transcriptPath, ownPath);
  });
}

test('herdr timing out and coming back with the same stale value does not switch to the session it names', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const ownId = 'c1c1c1c1-0000-4000-8000-000000000001';
  const otherId = 'd2d2d2d2-0000-4000-8000-000000000002';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now());
  const otherPath = writeTranscript(projectsDirectory, '/srv/work', otherId, Date.now() - 60_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: ownId, transcriptPath: ownPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(otherId)).runCommand })).transcriptPath, ownPath);
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrTimingOut() })).transcriptPath, ownPath);
  // 逾時期間 herdr 指向的 session 在別的 pane 被寫，寫得比較近
  touch(otherPath, Date.now() + 10_000);
  const recovered = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(otherId)).runCommand });
  assert.equal(recovered.transcriptPath, otherPath);
  assert.equal(follower.offer(recovered).transcriptPath, ownPath);
  assert.equal(follower.switches, 0);
});

test('the pane map changing to a new session switches to it even when the stale herdr session was written more recently', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  // herdr 過期、一直說 staleId；這個 pane 開了新 session，開第一個 sub 時 hook 才把 pane map 改成 newId
  const staleId = 'e3e3e3e3-0000-4000-8000-000000000003';
  const newId = 'f4f4f4f4-0000-4000-8000-000000000004';
  const stalePath = writeTranscript(projectsDirectory, '/srv/work', staleId, Date.now());
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: staleId, transcriptPath: stalePath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(staleId)).runCommand };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession(base)).transcriptPath, stalePath);
  const newPath = writeTranscript(projectsDirectory, '/srv/work', newId, Date.now() + 1_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: newId, transcriptPath: newPath, cwd: '/srv/work', updatedAtMs: 0 });
  touch(stalePath, Date.now() + 5_000);
  const next = await resolveSession(base);
  assert.equal(next.transcriptPath, stalePath);
  const current = follower.offer(next);
  assert.equal(current.transcriptPath, newPath);
  assert.equal(current.source, 'pane-map');
  assert.equal(current.isGuessed, false);
  assert.equal(current.statusNote, next.statusNote);
  assert.equal(follower.switches, 1);
  // 之後兩邊輪流寫也不會換回去
  touch(newPath, Date.now() + 10_000);
  follower.offer(await resolveSession(base));
  touch(stalePath, Date.now() + 15_000);
  assert.equal(follower.offer(await resolveSession(base)).transcriptPath, newPath);
  assert.equal(follower.switches, 1);
});

test('herdr changing to a new session switches to it, also once a transcript that did not exist yet appears', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const oldId = 'a5a5a5a5-0000-4000-8000-000000000005';
  const newId = 'b6b6b6b6-0000-4000-8000-000000000006';
  const staleMapId = 'c7c7c7c7-0000-4000-8000-000000000007';
  const oldPath = writeTranscript(projectsDirectory, '/srv/work', oldId, Date.now());
  // pane map 過期，指向的 session 在別的 pane 被寫
  const staleMapPath = writeTranscript(projectsDirectory, '/srv/work', staleMapId, Date.now() - 60_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: staleMapId, transcriptPath: staleMapPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(oldId)).runCommand })).transcriptPath, oldPath);
  // 新 session 還沒寫第一行：不換，也不能把這次回報記成看過
  const waiting = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(follower.offer(waiting).transcriptPath, oldPath);
  const newPath = writeTranscript(projectsDirectory, '/srv/work', newId, Date.now() + 1_000);
  touch(staleMapPath, Date.now() + 5_000);
  const next = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(next.transcriptPath, staleMapPath);
  assert.equal(follower.offer(next).transcriptPath, newPath);
  assert.equal(follower.switches, 1);
});

test('a source reporting for the first time only wins when its transcript is newer, and only that once', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const ownId = 'd8d8d8d8-0000-4000-8000-000000000008';
  const staleId = 'e9e9e9e9-0000-4000-8000-000000000009';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now());
  const stalePath = writeTranscript(projectsDirectory, '/srv/work', staleId, Date.now() - 60_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: ownId, transcriptPath: ownPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  // herdr 一開始就失敗：只有 pane map
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrFailing() })).transcriptPath, ownPath);
  // herdr 恢復，第一次回報的 session 比 current 舊：不換
  const herdrStale = herdrReturning(herdrClaudePane(staleId)).runCommand;
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrStale })).transcriptPath, ownPath);
  // 之後它在別的 pane 被寫得比較近：herdr 的值沒變，還是不換
  touch(stalePath, Date.now() + 10_000);
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrStale })).transcriptPath, ownPath);
  assert.equal(follower.switches, 0);
});

test('both sources changing in the same lookup follow the more recently written transcript', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const firstId = 'a1b2c3d4-0000-4000-8000-000000000001';
  const herdrNextId = 'a1b2c3d4-0000-4000-8000-000000000002';
  const paneMapNextId = 'a1b2c3d4-0000-4000-8000-000000000003';
  const firstPath = writeTranscript(projectsDirectory, '/srv/work', firstId, Date.now() - 60_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: firstId, transcriptPath: firstPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(firstId)).runCommand })).transcriptPath, firstPath);
  writeTranscript(projectsDirectory, '/srv/work', herdrNextId, Date.now() - 30_000);
  const paneMapNextPath = writeTranscript(projectsDirectory, '/srv/work', paneMapNextId, Date.now());
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: paneMapNextId, transcriptPath: paneMapNextPath, cwd: '/srv/work', updatedAtMs: 0 });
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(herdrNextId)).runCommand })).transcriptPath, paneMapNextPath);
});

test('a current session whose transcript was deleted is picked again from scratch', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const ownId = 'f0f0f0f0-0000-4000-8000-000000000001';
  const otherId = 'f0f0f0f0-0000-4000-8000-000000000002';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now());
  const otherPath = writeTranscript(projectsDirectory, '/srv/work', otherId, Date.now() - 60_000);
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: otherId, transcriptPath: otherPath, cwd: '/srv/work', updatedAtMs: 0 });
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(ownId)).runCommand };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession(base)).transcriptPath, ownPath);
  fs.rmSync(ownPath);
  // 兩個來源的值都沒變，但 current 的 transcript 不見了：照初次選擇重選
  assert.equal(follower.offer(await resolveSession(base)).transcriptPath, otherPath);
});

test('the herdr / pane map disagreement note carries no terminal escapes', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  // herdr 的 agent_session 可以是 transcript 的絕對路徑，session id 就取檔名：檔名裡的 escape 會跟著進 note
  const projectDirectory = path.join(projectsDirectory, encodeProjectDirectoryName('/srv/work'));
  fs.mkdirSync(projectDirectory, { recursive: true });
  const hostilePath = path.join(projectDirectory, 'ev\u001b]52;c;QQ==\u0007\u202eil.jsonl');
  fs.writeFileSync(hostilePath, '{}\n');
  const olderDate = new Date(Date.now() - 60_000);
  fs.utimesSync(hostilePath, olderDate, olderDate);
  const mappedId = 'abcdef01-0000-4000-8000-000000000001';
  const mappedPath = writeTranscript(projectsDirectory, '/srv/work', mappedId, Date.now());
  writePaneMap(runtimeDirectory, 'w1:p1', { sessionId: mappedId, transcriptPath: mappedPath, cwd: '/srv/work', updatedAtMs: 0 });
  const { runCommand } = herdrReturning(herdrClaudePane(hostilePath));
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, mappedPath);
  assert.match(result.statusNote, /^herdr says session ev.*, pane map says abcdef01$/);
  assert.doesNotMatch(result.statusNote, terminalControlPattern);
});

// macOS 第一次執行剛寫好的 script 要 0.6–1.5 秒（系統掃描新檔案），第二次起只要幾 ms；
// 先用 --warm-up 跑一次，不然 300 ms 逾時的測試裡 shell 還沒開始跑就被 kill
function writeExecutable(name, body) {
  const filePath = path.join(temporaryRoot, name);
  fs.writeFileSync(filePath, `#!/bin/sh\n[ "$1" = --warm-up ] && exit 0\n${body}\n`, { mode: 0o755 });
  execFileSync(filePath, ['--warm-up']);
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

// hook 收到 SessionStart 時寫的 pane map（sessionStartSource）：transcript 在就直接用，不跟 herdr 比 mtime
function writeSessionStartPaneMap(runtimeDirectory, paneId, sessionId, transcriptPath, source = 'startup') {
  writePaneMap(runtimeDirectory, paneId, { sessionId, transcriptPath, cwd: '/srv/work', updatedAtMs: Date.now(), sessionStartSource: source });
}

test('a pane map written at SessionStart is used as is, even when the stale herdr session was written more recently', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const staleId = 'aaab440d-0000-4000-8000-0000000000a1';
  const ownId = '3cd69807-0000-4000-8000-0000000000a2';
  writeTranscript(projectsDirectory, '/srv/work', staleId, Date.now());
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now() - 60_000);
  writeSessionStartPaneMap(runtimeDirectory, 'w1:p1', ownId, ownPath, 'resume');
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(staleId)).runCommand });
  assert.equal(result.transcriptPath, ownPath);
  assert.equal(result.source, 'pane-map');
  assert.equal(result.isSessionStart, true);
  assert.equal(result.statusNote, 'herdr says session aaab440d, pane map says 3cd69807');
});

test('with a SessionStart pane map, herdr changing its value does not move the viewer, the pane map changing does', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const ownId = 'b1b1b1b1-0000-4000-8000-0000000000b1';
  const herdrFirstId = 'b1b1b1b1-0000-4000-8000-0000000000b2';
  const herdrNextId = 'b1b1b1b1-0000-4000-8000-0000000000b3';
  const nextOwnId = 'b1b1b1b1-0000-4000-8000-0000000000b4';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now() - 60_000);
  writeTranscript(projectsDirectory, '/srv/work', herdrFirstId, Date.now() - 30_000);
  writeSessionStartPaneMap(runtimeDirectory, 'w1:p1', ownId, ownPath);
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(herdrFirstId)).runCommand })).transcriptPath, ownPath);
  // herdr 的值變了、指向寫得最近的 transcript（例：herdr server 重啟後還原的舊值，在別的 pane 被寫）：不換
  writeTranscript(projectsDirectory, '/srv/work', herdrNextId, Date.now() + 10_000);
  const herdrNext = herdrReturning(herdrClaudePane(herdrNextId)).runCommand;
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrNext })).transcriptPath, ownPath);
  assert.equal(follower.switches, 0);
  // /clear、/resume：SessionStart 改寫 pane map，就算新 transcript 比 herdr 的舊也換過去
  const nextOwnPath = writeTranscript(projectsDirectory, '/srv/work', nextOwnId, Date.now() - 120_000);
  writeSessionStartPaneMap(runtimeDirectory, 'w1:p1', nextOwnId, nextOwnPath, 'clear');
  const switched = follower.offer(await resolveSession({ ...base, runCommand: herdrNext }));
  assert.equal(switched.transcriptPath, nextOwnPath);
  assert.equal(switched.source, 'pane-map');
  assert.equal(follower.switches, 1);
});

test('a SessionStart pane map whose transcript does not exist yet keeps the old rules until it appears, then wins', async () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const herdrId = 'c2c2c2c2-0000-4000-8000-0000000000c1';
  const newId = 'c2c2c2c2-0000-4000-8000-0000000000c2';
  const herdrPath = writeTranscript(projectsDirectory, '/srv/work', herdrId, Date.now());
  // 實測（2.1.296）：SessionStart（startup）觸發時 transcript 還不存在，第一個 prompt 之後才寫出來
  const newPath = path.join(projectsDirectory, encodeProjectDirectoryName('/srv/work'), `${newId}.jsonl`);
  writeSessionStartPaneMap(runtimeDirectory, 'w1:p1', newId, newPath);
  const base = { paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(herdrId)).runCommand };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession(base)).transcriptPath, herdrPath);
  // transcript 出現了，寫入時間比 herdr 那個舊：仍然換過去
  writeTranscript(projectsDirectory, '/srv/work', newId, Date.now() - 60_000);
  const current = follower.offer(await resolveSession(base));
  assert.equal(current.transcriptPath, newPath);
  assert.equal(current.isSessionStart, true);
});
