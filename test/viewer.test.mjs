import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const repositoryDirectory = fileURLToPath(new URL('..', import.meta.url));
const viewerPath = path.join(repositoryDirectory, 'viewer.mjs');
const demoPath = path.join(repositoryDirectory, 'demo.mjs');
const fixtureProjectDirectory = path.join(repositoryDirectory, 'test', 'fixtures', 'viewer', 'projects', '-tmp-demo-project');
const fixtureSessionId = '11111111-2222-4333-8444-555555555555';
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-viewer-'));
after(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

let copyCounter = 0;

// 複製一份 fixture：mtime 變成現在，跑中的 sub 才不會被 10 分鐘 stale 規則判成結束
function copyFixtureSession() {
  copyCounter += 1;
  const projectDirectory = path.join(temporaryRoot, `copy-${copyCounter}`, '-tmp-demo-project');
  fs.cpSync(fixtureProjectDirectory, projectDirectory, { recursive: true });
  return path.join(projectDirectory, `${fixtureSessionId}.jsonl`);
}

function isolatedEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('HERDR_') || key.startsWith('SUBAGENT_WATCH_')) {
      delete environment[key];
    }
  }
  return { ...environment, ...extra };
}

function runViewer(args, { environment = isolatedEnvironment(), cwd = repositoryDirectory, scriptPath = viewerPath } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, env: environment, encoding: 'utf8', timeout: 10_000 });
}

test('--once --session prints a frame from a real transcript layout and exits 0 without a TTY', () => {
  const transcriptPath = copyFixtureSession();
  const result = runViewer(['--once', '--session', transcriptPath]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 24);
  assert.equal(lines[0], '◀ [Explore ●] [general-purpose: Write the README ✓] ▶');
  assert.doesNotMatch(lines[0], /\d/);
  // 第一次開啟選最新的跑中 sub：fixture 只有 Explore 還在跑
  assert.match(result.stdout, /Grep {8}emitKeypressEvents/);
  assert.match(result.stdout, /Bash {8}git status --short ls src/);
  assert.match(result.stdout, /thinking\.\.\./);
  assert.doesNotMatch(result.stdout, /file body/);
  assert.match(lines[22], /session 11111111/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('--once --demo prints demo tabs without numbers', () => {
  const result = runViewer(['--once', '--demo']);
  assert.equal(result.status, 0, result.stderr);
  const [tabBar] = result.stdout.split('\n');
  assert.equal(tabBar, '◀ [Explore ●] [claude-code-guide ✓] [general-purpose ●] ▶');
  assert.match(result.stdout, /demo data/);
  assert.doesNotMatch(result.stdout, /closing in/);
});

test('demo.mjs is a thin wrapper around viewer.mjs --demo', () => {
  const result = runViewer(['--once'], { scriptPath: demoPath });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split('\n')[0], /^◀ \[Explore ●\] \[claude-code-guide ✓\]/);
  assert.match(result.stdout, /demo data/);
});

test('inside a plugin popup without any pane information the viewer explains it found no session', () => {
  const result = runViewer(['--once'], {
    environment: isolatedEnvironment({
      HERDR_PLUGIN_ID: 'subagent.watch',
      HERDR_BIN_PATH: '/nonexistent/herdr',
      XDG_RUNTIME_DIR: temporaryRoot,
      CLAUDE_CONFIG_DIR: path.join(temporaryRoot, 'no-config'),
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Claude Code session found for this pane/);
  assert.match(result.stdout, /no pane id available/);
  assert.match(result.stdout, /no session/);
});

test('the popup uses the pane id from the open action and labels a cwd guess', () => {
  const configDirectory = path.join(temporaryRoot, 'guess-config');
  const workDirectory = path.join(temporaryRoot, 'guess-work');
  fs.mkdirSync(workDirectory, { recursive: true });
  const projectDirectory = path.join(configDirectory, 'projects', fs.realpathSync(workDirectory).replaceAll('/', '-'));
  fs.cpSync(fixtureProjectDirectory, projectDirectory, { recursive: true });
  const result = runViewer(['--once'], {
    environment: isolatedEnvironment({
      HERDR_PLUGIN_ID: 'subagent.watch',
      HERDR_BIN_PATH: '/nonexistent/herdr',
      SUBAGENT_WATCH_PANE_ID: 'w9:p9',
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w9:p8', focused_pane_cwd: workDirectory }),
      XDG_RUNTIME_DIR: temporaryRoot,
      CLAUDE_CONFIG_DIR: configDirectory,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session 11111111 \(guessed: latest session\)/);
  assert.match(result.stdout, /\[Explore ●\]/);
});

test('unknown arguments exit with status 2', () => {
  const result = runViewer(['--bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});

const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function startInPty(args, { columns = 120, rows = 16 } = {}) {
  const command = `stty cols ${columns} rows ${rows}; exec ${JSON.stringify(process.execPath)} ${[viewerPath, ...args].map((argument) => JSON.stringify(argument)).join(' ')}`;
  const child = spawn('script', ['-qfec', command, '/dev/null'], { env: isolatedEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const session = { output: '', exitCode: null, exitedAtMs: null };
  child.stdout.on('data', (chunk) => {
    session.output += chunk.toString('utf8');
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => {
      session.exitCode = code;
      session.exitedAtMs = Date.now();
      resolve(code);
    });
  });
  async function waitForOutput(pattern, timeoutMs = 5000) {
    const startMs = Date.now();
    // 沒選取的 tab 中間夾著顏色碼，比對時同時看原始輸出與去掉 ANSI 的版本
    while (!pattern.test(session.output) && !pattern.test(stripAnsi(session.output))) {
      if (Date.now() - startMs > timeoutMs) {
        throw new Error(`timed out waiting for ${pattern}; output so far:\n${session.output.slice(-2000)}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  return {
    session,
    exited,
    waitForOutput,
    send(keys) {
      child.stdin.write(keys);
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
}

function selectedLabels(output) {
  const labels = [];
  for (const match of output.matchAll(/\x1b\[7m\x1b\[1m\[([^\]]+?) [●✓]\]/g)) {
    if (labels.at(-1) !== match[1]) {
      labels.push(match[1]);
    }
  }
  return labels;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('interactive mode in a pty', { skip: !hasScript && 'util-linux script is not available' }, () => {
  test('left/right cycle through tabs, digits do nothing, q exits 0 and restores the terminal', { timeout: 20_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const pty = startInPty(['--session', transcriptPath]);
    try {
      await pty.waitForOutput(/\[Explore ●\]/);
      pty.send('\x1b[C');
      await pty.waitForOutput(/\x1b\[7m\x1b\[1m\[general-purpose: Write the README ✓\]/);
      pty.send('1');
      await sleep(300);
      assert.equal(selectedLabels(pty.session.output).at(-1), 'general-purpose: Write the README');
      pty.send('\x1b[D');
      await sleep(150);
      pty.send('\x1b[D');
      await pty.waitForOutput(/\x1b\[7m\x1b\[1m\[fork ✓\]/);
      pty.send('q');
      assert.equal(await pty.exited, 0);
      assert.deepEqual(selectedLabels(pty.session.output), ['Explore', 'general-purpose: Write the README', 'Explore', 'fork']);
      assert.ok(pty.session.output.includes('\x1b[?1049h'));
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assert.ok(pty.session.output.includes('\x1b[?25h'));
    } finally {
      pty.kill();
    }
  });

  test('Esc closes right away with exit 0', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      await pty.waitForOutput(/\[Explore ●\]/);
      const sentAtMs = Date.now();
      pty.send('\x1b');
      assert.equal(await pty.exited, 0);
      assert.ok(pty.session.exitedAtMs - sentAtMs < 400, `took ${pty.session.exitedAtMs - sentAtMs} ms`);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
    } finally {
      pty.kill();
    }
  });

  test('Ctrl+C exits 0 and restores the terminal', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      await pty.waitForOutput(/\[Explore ●\]/);
      pty.send('\x03');
      assert.equal(await pty.exited, 0);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assert.ok(pty.session.output.includes('\x1b[?25h'));
    } finally {
      pty.kill();
    }
  });

  test('the viewer never closes on its own and adds a tab when a new agent file appears', { timeout: 20_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const pty = startInPty(['--session', transcriptPath], { columns: 200 });
    try {
      await pty.waitForOutput(/\[Explore ●\]/);
      await sleep(3000);
      assert.equal(pty.session.exitCode, null);
      const subagentsDirectory = path.join(path.dirname(transcriptPath), fixtureSessionId, 'subagents');
      fs.writeFileSync(path.join(subagentsDirectory, 'agent-e555late.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan next step' }));
      fs.writeFileSync(
        path.join(subagentsDirectory, 'agent-e555late.jsonl'),
        `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T01:30:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_late', name: 'Glob', input: { pattern: '**/*.mjs' } }] } })}\n`,
      );
      await pty.waitForOutput(/\[Plan ●\]/, 3000);
      assert.equal(pty.session.exitCode, null);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });
});
