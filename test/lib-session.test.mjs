import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  encodeProjectDirectoryName,
  findLatestTranscript,
  getCwdVariants,
  isSafePaneId,
  isSafeSessionId,
  resolveSession,
} from '../lib/session.mjs';

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
  const runCommand = (binPath, args) => {
    calls.push([binPath, ...args]);
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
  assert.equal(encodeProjectDirectoryName('/var/home/hotpapa'), '-var-home-hotpapa');
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

test('path a: herdr agent_session id resolves to the transcript in any project folder', () => {
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
  const result = resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, herdrBinPath: '/fake/herdr', runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.source, 'herdr');
  assert.equal(result.isGuessed, false);
  assert.deepEqual(calls, [['/fake/herdr', 'pane', 'get', 'w1:p1']]);
});

test('path a: a reported session without a transcript yet waits instead of guessing an older session', () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/work', 'old00000-0000-4000-8000-000000000000');
  const { runCommand } = herdrReturning({
    pane_id: 'w1:p1',
    agent_session: { agent: 'claude', kind: 'id', value: 'new00000-0000-4000-8000-000000000000' },
    foreground_cwd: '/srv/work',
  });
  const result = resolveSession({ paneId: 'w1:p1', projectsDirectory, runtimeDirectory, runCommand });
  assert.equal(result.isTranscriptMissing, true);
  assert.equal(result.isGuessed, false);
  assert.equal(result.transcriptPath, path.join(projectsDirectory, '-srv-work', 'new00000-0000-4000-8000-000000000000.jsonl'));
});

test('path b: the pane map written by the hook is used when herdr has no session', () => {
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
  const result = resolveSession({ paneId: 'w2:p3', projectsDirectory, runtimeDirectory, runCommand });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.source, 'pane-map');
  assert.equal(result.isGuessed, false);
});

test('path b: a pane map with only sessionId is looked up by id', () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const sessionId = 'dddd4444-0000-4000-8000-000000000004';
  const transcriptPath = writeTranscript(projectsDirectory, '/srv/mapped', sessionId);
  fs.mkdirSync(path.join(runtimeDirectory, 'subagent-watch'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDirectory, 'subagent-watch', 'pane-w2:p4.json'), JSON.stringify({ sessionId, cwd: '/srv/mapped' }));
  const result = resolveSession({ paneId: 'w2:p4', projectsDirectory, runtimeDirectory, runCommand: herdrFailing() });
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.source, 'pane-map');
});

test('path c: without herdr or pane map, the newest transcript for the pane cwd is guessed', () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  writeTranscript(projectsDirectory, '/srv/guess', 'eeee5555-0000-4000-8000-000000000005', Date.now() - 60_000);
  const newestPath = writeTranscript(projectsDirectory, '/srv/guess', 'ffff6666-0000-4000-8000-000000000006', Date.now());
  writeTranscript(projectsDirectory, '/srv/other', 'abab7777-0000-4000-8000-000000000007', Date.now() + 60_000);
  const result = resolveSession({
    paneId: 'w3:p1',
    contextCwd: '/srv/guess',
    projectsDirectory,
    runtimeDirectory,
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

test('a non-claude agent session in the pane is not used', () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const { runCommand } = herdrReturning({
    pane_id: 'w4:p1',
    agent: 'codex',
    agent_session: { agent: 'codex', kind: 'id', value: 'codex-session' },
    cwd: '/srv/none',
  });
  const result = resolveSession({ paneId: 'w4:p1', projectsDirectory, runtimeDirectory, runCommand });
  assert.equal(result.transcriptPath, null);
  assert.ok(result.notes.some((note) => note.includes('has no claude agent_session')));
});

test('nothing to go on yields an unresolved result with notes instead of throwing', () => {
  const { projectsDirectory, runtimeDirectory } = createCase();
  const result = resolveSession({ paneId: null, projectsDirectory, runtimeDirectory, runCommand: herdrFailing() });
  assert.equal(result.transcriptPath, null);
  assert.ok(result.notes.includes('no pane id available'));
});
