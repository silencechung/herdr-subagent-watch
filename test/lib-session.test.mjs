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
  fs.mkdirSync(projectsDirectory, { recursive: true });
  return { caseDirectory, projectsDirectory };
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
  const { projectsDirectory } = createCase();
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
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.source, 'herdr');
  assert.equal(result.isGuessed, false);
  assert.deepEqual(calls, [['/fake/herdr', 'pane', 'get', 'w1:p1']]);
});

test('path a: a reported session without a transcript yet waits instead of guessing an older session', async () => {
  const { projectsDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'old00000-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning({
    pane_id: 'w1:p1',
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', value: 'new00000-0000-4000-8000-000000000000' },
    foreground_cwd: '/srv/work',
  });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.isTranscriptMissing, true);
  assert.equal(result.isGuessed, false);
  assert.equal(result.transcriptPath, path.join(projectsDirectory, '-srv-work', 'new00000-0000-4000-8000-000000000000.jsonl'));
});

test('path c: without a session from herdr, the newest transcript for the pane cwd is guessed', async () => {
  const { projectsDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/guess', 'eeee5555-0000-4000-8000-000000000005', Date.now() - 60_000);
  const newestPath = writeTranscript(projectsDirectory, '/srv/guess', 'ffff6666-0000-4000-8000-000000000006', Date.now());
  writeTranscript(projectsDirectory, '/srv/other', 'abab7777-0000-4000-8000-000000000007', Date.now() + 60_000);
  const result = await resolveSession({
    paneId: 'w3:p1',
    contextCwd: '/srv/guess',
    projectsDirectory,
    herdrBinPath: '/fake/herdr',
    runCommand: herdrFailing(),
  });
  assert.equal(result.transcriptPath, newestPath);
  assert.equal(result.source, 'guessed');
  assert.equal(result.isGuessed, true);
  assert.ok(result.notes.some((note) => note.includes('herdr pane get failed')));
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
  const { projectsDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'abcd0000-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-codex.json'));
  const result = await resolveSession({ paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, null);
  assert.equal(result.isGuessed, false);
  assert.equal(result.isTranscriptMissing, true);
  assert.deepEqual(result.nonClaudePane, { detectedAgent: 'codex' });
  assert.equal(describeNonClaudePane(result.nonClaudePane), 'This pane is not running Claude Code (detected: codex)');
});

test('a plain shell pane (no agent key) says there is no Claude Code session and does not guess', async () => {
  const { projectsDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'abcd1111-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-shell.json'));
  const result = await resolveSession({ paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, null);
  assert.equal(result.isGuessed, false);
  assert.deepEqual(result.nonClaudePane, { detectedAgent: null });
  assert.equal(describeNonClaudePane(result.nonClaudePane), 'No Claude Code session in this pane');
});

test('herdr detection wins over a leftover claude agent_session on a pane now running another agent', async () => {
  const { projectsDirectory } = createCase();
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-codex.json', {
    agent_session: { agent: 'claude', kind: 'id', value: 'abcd2222-0000-4000-8000-000000000000' },
  }));
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.deepEqual(result.nonClaudePane, { detectedAgent: 'codex' });
});

test('the real claude pane shape resolves through agent_session', async () => {
  const { projectsDirectory } = createCase();
  const pane = readPaneFixture('pane-get-claude.json');
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/work', pane.agent_session.value);
  const { runCommand } = herdrReturning(pane);
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.source, 'herdr');
  assert.equal(result.nonClaudePane, undefined);
});

test('a claude pane without agent_session falls back to the cwd guess', async () => {
  const { projectsDirectory } = createCase();
  const newestPath = writeTranscript(projectsDirectory, '/srv/work', 'abcd3333-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning(readPaneFixture('pane-get-claude-without-session.json'));
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, newestPath);
  assert.equal(result.isGuessed, true);
  assert.ok(result.notes.some((note) => note.includes('has no claude agent_session')));
});

test('without a herdr binary the viewer falls back to guessing and says why', async () => {
  const { projectsDirectory } = createCase();
  const newestPath = writeTranscript(projectsDirectory, '/srv/nobin', 'abcd4444-0000-4000-8000-000000000000');
  const result = await resolveSession({ paneId: 'w1:p1', contextCwd: '/srv/nobin', projectsDirectory, herdrBinPath: null });
  assert.equal(result.transcriptPath, newestPath);
  assert.equal(result.isGuessed, true);
  assert.ok(result.notes.some((note) => note.startsWith('herdr not found')));
});

test('detected agent names are cleaned before they reach the screen', async () => {
  const { projectsDirectory } = createCase();
  const { runCommand } = herdrReturning({ pane_id: 'w1:p1', agent: 'evil\u001b[31m\nagent' });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.doesNotMatch(result.nonClaudePane.detectedAgent, /[\u0000-\u001f]/);
});

test('nothing to go on yields an unresolved result with notes instead of throwing', async () => {
  const { projectsDirectory } = createCase();
  const result = await resolveSession({ paneId: null, projectsDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrFailing() });
  assert.equal(result.transcriptPath, null);
  assert.ok(result.notes.includes('no pane id available'));
});

// 外來字串進 notes 前要剝掉 ESC／C1／bidi：notes 會原樣畫在 popup 上
const terminalControlPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

test('notes built from herdr values, pane ids and cwds carry no terminal escapes', async () => {
  const { projectsDirectory } = createCase();
  const { runCommand } = herdrReturning({
    pane_id: 'w1:p1',
    agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', value: 'evil\u001b]52;c;cHduZWQ=\u0007\u009b2J\u202eid' },
    foreground_cwd: '/srv/x\u001b]8;;https://evil.example/\u001b\\link',
  });
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  // 不合格的 session id 不能拼成「等它出現」的路徑
  assert.equal(result.transcriptPath, null);
  assert.ok(result.notes.some((note) => note.startsWith('herdr reported session evil')));
  assert.ok(result.notes.some((note) => note.startsWith('no transcripts found for cwd /srv/x')));
  for (const note of result.notes) {
    assert.doesNotMatch(note, terminalControlPattern, JSON.stringify(note));
  }

  const unsafe = await resolveSession({ paneId: '../\u009b31m\u001b[2J', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.ok(unsafe.notes[0].startsWith('ignored unsafe pane id'));
  for (const note of unsafe.notes) {
    assert.doesNotMatch(note, terminalControlPattern, JSON.stringify(note));
  }
});

test('resolveSession hands its abort signal to the herdr command', async () => {
  const { projectsDirectory } = createCase();
  const abortController = new AbortController();
  let receivedSignal = null;
  const runCommand = (binPath, argumentList, { signal }) => {
    receivedSignal = signal;
    return JSON.stringify({ result: { pane: { agent: 'codex' } } });
  };
  await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand, signal: abortController.signal });
  assert.equal(receivedSignal, abortController.signal);
});

// resolveSession 走 pane 那條路的結果：paneCandidates 是 herdr 回報的候選
function lookupResult(chosen, { herdr = null } = {}) {
  return { ...chosen, statusNote: null, notes: [], paneCandidates: { herdr } };
}

test('shouldReplaceSession switches only when herdr reports a new session, and never downgrades to a guess or to nothing', () => {
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
  const guessedC = session('c0000000-0000-4000-8000-000000000003', 'guessed', nowMs + 60_000);
  const guessedD = session('d0000000-0000-4000-8000-000000000004', 'guessed', nowMs + 120_000);
  const unresolved = { transcriptPath: null, sessionId: null, source: null, isGuessed: false };
  const fromHerdr = (candidate) => lookupResult(candidate, { herdr: candidate });
  assert.equal(shouldReplaceSession(null, unresolved), true);
  assert.equal(shouldReplaceSession(unresolved, unresolved), true);
  assert.equal(shouldReplaceSession(unresolved, guessedC), true);
  // /resume、重開 claude：herdr 回報的值變了
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), fromHerdr(herdrNew)), true);
  // 值變了就換，不看 mtime：過期的 session 可能正被別的 pane 寫，mtime 分不出誰才是這個 pane 的
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr(herdrOld)), true);
  // herdr 的值沒變（上次查詢就是 herdrOld）：不換，就算 current 是另一個 transcript
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr(herdrOld), { lastSeenSessionIds: { herdr: herdrOld.sessionId } }), false);
  // 同一個 transcript 換成新的結果（例 isTranscriptMissing、statusNote 變了）
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr({ ...herdrNew })), true);
  // 猜的被 herdr 給的取代，就算猜的寫得比較近
  assert.equal(shouldReplaceSession(guessedC, fromHerdr(herdrOld)), true);
  // 猜的不能取代 herdr 給的，同一個 transcript 也不行
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), guessedC), false);
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), { ...herdrOld, source: 'guessed', isGuessed: true }), false);
  assert.equal(shouldReplaceSession(fromHerdr(herdrOld), unresolved), false);
  // 猜的換猜的：現在的 transcript 還在就不換，就算另一個寫得比較近
  assert.equal(shouldReplaceSession(guessedC, guessedD), false);
  // 同一個 session id 只是路徑不同：值沒變，不換
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr({ ...herdrNew, transcriptPath: '/elsewhere/x.jsonl' }), { getModifiedMs: () => nowMs }), false);

  fs.rmSync(guessedC.transcriptPath);
  fs.rmSync(herdrNew.transcriptPath);
  // 現在的 transcript 不見了：換成任何還在的 session，herdr 的值沒變也一樣
  assert.equal(shouldReplaceSession(guessedC, guessedD), true);
  assert.equal(shouldReplaceSession(fromHerdr(herdrNew), fromHerdr(herdrOld), { lastSeenSessionIds: { herdr: herdrOld.sessionId } }), true);
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

test('herdr timing out falls back to a cwd guess, and the viewer keeps the session herdr reported', async () => {
  const { projectsDirectory } = createCase();
  const ownId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const otherId = 'bbbbbbbb-0000-4000-8000-000000000002';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now() - 60_000);
  // 同一個資料夾裡寫得比較近的別的 session：逾時退回去猜時會猜到它
  const otherPath = writeTranscript(projectsDirectory, '/srv/work', otherId, Date.now());
  const base = { paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, herdrBinPath: '/fake/herdr' };
  const current = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(ownId)).runCommand });
  assert.equal(current.transcriptPath, ownPath);
  const duringTimeout = await resolveSession({ ...base, runCommand: herdrTimingOut() });
  assert.equal(duringTimeout.transcriptPath, otherPath);
  assert.equal(duringTimeout.isGuessed, true);
  assert.ok(duringTimeout.notes.includes('herdr pane get failed (timed out)'));
  assert.equal(shouldReplaceSession(current, duringTimeout), false);
  const recovered = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(ownId)).runCommand });
  assert.equal(shouldReplaceSession(current, recovered), true);
  assert.equal(recovered.transcriptPath, current.transcriptPath);
});

test('with two sessions writing in turn in the same folder, a guessed session sticks until its transcript is gone', async () => {
  const { projectsDirectory } = createCase();
  const firstPath = writeTranscript(projectsDirectory, '/srv/shared', 'e5e5e5e5-0000-4000-8000-000000000005', Date.now() - 1_000);
  const secondPath = writeTranscript(projectsDirectory, '/srv/shared', 'f6f6f6f6-0000-4000-8000-000000000006', Date.now() - 2_000);
  const base = { paneId: null, fallbackCwd: '/srv/shared', projectsDirectory, herdrBinPath: null };
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

test('a stale herdr naming a session another pane keeps writing does not make the viewer flap', async () => {
  const { projectsDirectory } = createCase();
  // herdr 過期、一直回報 staleId（它在別的 pane 被 \`claude -c\` 接著寫）；同一個資料夾裡另一個 session 也在寫
  const staleId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const otherId = 'bbbbbbbb-0000-4000-8000-000000000002';
  const startMs = Date.now();
  const stalePath = writeTranscript(projectsDirectory, '/srv/work', staleId, startMs - 1_000);
  const otherPath = writeTranscript(projectsDirectory, '/srv/work', otherId, startMs);
  const base = { paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(staleId)).runCommand };
  const follower = createSessionFollower();
  let statelessCurrent = null;
  let statelessSwitches = 0;
  for (let round = 0; round < 10; round += 1) {
    // 兩個 session 在兩次查詢之間輪流寫
    touch(round % 2 === 0 ? otherPath : stalePath, startMs + (round + 1) * 2_000);
    const next = await resolveSession(base);
    assert.equal(follower.offer(next).transcriptPath, stalePath, `round ${round}`);
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
  assert.equal(statelessCurrent.transcriptPath, stalePath);
});

test('herdr timing out and coming back with the same value does not switch away, even to a session written more recently', async () => {
  const { projectsDirectory } = createCase();
  const ownId = 'c1c1c1c1-0000-4000-8000-000000000001';
  const otherId = 'd2d2d2d2-0000-4000-8000-000000000002';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now());
  const otherPath = writeTranscript(projectsDirectory, '/srv/work', otherId, Date.now() - 60_000);
  const base = { paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(ownId)).runCommand })).transcriptPath, ownPath);
  // 逾時期間另一個 session 在別的 pane 被寫，寫得比較近：退回去猜會猜到它，但猜的不能取代 herdr 給的
  touch(otherPath, Date.now() + 10_000);
  const duringTimeout = await resolveSession({ ...base, runCommand: herdrTimingOut() });
  assert.equal(duringTimeout.transcriptPath, otherPath);
  assert.equal(follower.offer(duringTimeout).transcriptPath, ownPath);
  // herdr 恢復、回報的值跟逾時前一樣：不換
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(ownId)).runCommand })).transcriptPath, ownPath);
  assert.equal(follower.switches, 0);
});

test('herdr changing to a new session switches to it, also once a transcript that did not exist yet appears', async () => {
  const { projectsDirectory } = createCase();
  const oldId = 'a5a5a5a5-0000-4000-8000-000000000005';
  const newId = 'b6b6b6b6-0000-4000-8000-000000000006';
  const oldPath = writeTranscript(projectsDirectory, '/srv/work', oldId, Date.now());
  const base = { paneId: 'w1:p1', projectsDirectory, herdrBinPath: '/fake/herdr' };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(oldId)).runCommand })).transcriptPath, oldPath);
  // 新 session 還沒寫第一行：不換，也不能把這次回報記成看過
  const waiting = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(waiting.isTranscriptMissing, true);
  assert.equal(follower.offer(waiting).transcriptPath, oldPath);
  // 新 transcript 寫得比舊的還早（時鐘或檔案時間不可靠）也照樣換：看的是 herdr 的值有沒有變
  const newPath = writeTranscript(projectsDirectory, '/srv/work', newId, Date.now() - 60_000);
  const next = await resolveSession({ ...base, runCommand: herdrReturning(herdrClaudePane(newId)).runCommand });
  assert.equal(next.transcriptPath, newPath);
  assert.equal(follower.offer(next).transcriptPath, newPath);
  assert.equal(follower.switches, 1);
});

test('a current session whose transcript was deleted is picked again from scratch', async () => {
  const { projectsDirectory } = createCase();
  const ownId = 'f0f0f0f0-0000-4000-8000-000000000001';
  const ownPath = writeTranscript(projectsDirectory, '/srv/work', ownId, Date.now());
  // 同一個資料夾裡的另一個 session：重選時不能因為 current 不見了就退回去猜它
  writeTranscript(projectsDirectory, '/srv/work', 'f0f0f0f0-0000-4000-8000-000000000002', Date.now() - 60_000);
  const base = { paneId: 'w1:p1', contextCwd: '/srv/work', projectsDirectory, herdrBinPath: '/fake/herdr', runCommand: herdrReturning(herdrClaudePane(ownId)).runCommand };
  const follower = createSessionFollower();
  assert.equal(follower.offer(await resolveSession(base)).transcriptPath, ownPath);
  fs.rmSync(ownPath);
  // herdr 的值沒變，但 current 的 transcript 不見了：照初次選擇重選，等 herdr 回報的 session 再出現
  const current = follower.offer(await resolveSession(base));
  assert.equal(current.transcriptPath, ownPath);
  assert.equal(current.isTranscriptMissing, true);
  assert.equal(current.isGuessed, false);
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
  const { projectsDirectory } = createCase();
  const result = await resolveSession({ paneId: 'w1:p1', projectsDirectory, herdrBinPath, runCommand });
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
