import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  assert.equal(lines[0], '1 running · 3 done │ ◀ [● Explore] [✓ general-purpose: Write the README] ▶');
  assert.doesNotMatch(lines[0].split('│')[1], /\d/);
  // 第一次開啟選最新的跑中 sub：fixture 只有 Explore 還在跑
  assert.match(result.stdout, /Grep {8}emitKeypressEvents/);
  assert.match(result.stdout, /Bash {8}git status --short ls src/);
  assert.match(result.stdout, /thinking\.\.\./);
  assert.doesNotMatch(result.stdout, /file body/);
  assert.match(lines[22], /session 11111111/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('--once --demo prints the summary and demo tabs without index numbers', () => {
  const result = runViewer(['--once', '--demo']);
  assert.equal(result.status, 0, result.stderr);
  const [tabBar] = result.stdout.split('\n');
  assert.equal(tabBar, '2 running · 1 done │ ◀ [● Explore] [✓ claude-code-guide] [● general-purpose] ▶');
  assert.match(result.stdout, /demo data/);
  assert.doesNotMatch(result.stdout, /closing in/);
});

test('demo.mjs is a thin wrapper around viewer.mjs --demo', () => {
  const result = runViewer(['--once'], { scriptPath: demoPath });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split('\n')[0], /^2 running · 1 done │ ◀ \[● Explore\] \[✓ claude-code-guide\]/);
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
  assert.match(result.stdout, /\[● Explore\]/);
});

// 假 herdr：`pane get` 回傳 herdr 0.9.3 實際輸出的 fixture
function writeFakeHerdr(fixtureName) {
  const fakePath = path.join(temporaryRoot, `herdr-${path.basename(fixtureName, '.json')}`);
  const fixture = fs.readFileSync(path.join(repositoryDirectory, 'test', 'fixtures', 'herdr', fixtureName), 'utf8');
  fs.writeFileSync(fakePath, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(fixture)});\n`, { mode: 0o755 });
  return fakePath;
}

// cwd 底下故意放一個 session：畫面若出現它，代表 viewer 還在猜
function popupEnvironmentWithGuessableSession(herdrBinPath, name) {
  const configDirectory = path.join(temporaryRoot, `${name}-config`);
  const workDirectory = path.join(temporaryRoot, `${name}-work`);
  fs.mkdirSync(workDirectory, { recursive: true });
  const projectDirectory = path.join(configDirectory, 'projects', fs.realpathSync(workDirectory).replaceAll('/', '-'));
  fs.cpSync(fixtureProjectDirectory, projectDirectory, { recursive: true });
  return isolatedEnvironment({
    HERDR_PLUGIN_ID: 'subagent.watch',
    HERDR_BIN_PATH: herdrBinPath,
    SUBAGENT_WATCH_PANE_ID: 'w1:p1',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p1', focused_pane_cwd: workDirectory }),
    XDG_RUNTIME_DIR: temporaryRoot,
    CLAUDE_CONFIG_DIR: configDirectory,
  });
}

test('a pane where herdr detects another agent says so instead of guessing a session', () => {
  const result = runViewer(['--once'], { environment: popupEnvironmentWithGuessableSession(writeFakeHerdr('pane-get-codex.json'), 'codex') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /This pane is not running Claude Code \(detected: codex\)/);
  assert.doesNotMatch(result.stdout, /guessed|Explore|No Claude Code session found/);
});

test('a plain shell pane says there is no Claude Code session in it', () => {
  const result = runViewer(['--once'], { environment: popupEnvironmentWithGuessableSession(writeFakeHerdr('pane-get-shell.json'), 'shell') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Claude Code session in this pane/);
  assert.doesNotMatch(result.stdout, /guessed|Explore|not running Claude Code/);
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

function startInPty(args, { columns = 120, rows = 16, environment = isolatedEnvironment() } = {}) {
  const command = `stty cols ${columns} rows ${rows}; exec ${JSON.stringify(process.execPath)} ${[viewerPath, ...args].map((argument) => JSON.stringify(argument)).join(' ')}`;
  const child = spawn('script', ['-qfec', command, '/dev/null'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
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
  // 每次重畫都從 cursor home 開始，最後一段就是目前畫面
  function getScreenLines() {
    return stripAnsi(session.output.split('\x1b[H').at(-1)).split(/\r*\n/);
  }
  async function waitForScreen(predicate, description, timeoutMs = 5000) {
    const startMs = Date.now();
    while (!predicate(getScreenLines())) {
      if (Date.now() - startMs > timeoutMs) {
        throw new Error(`timed out waiting for ${description}; screen:\n${getScreenLines().join('\n')}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    return getScreenLines();
  }
  return {
    session,
    exited,
    waitForOutput,
    getScreenLines,
    waitForScreen,
    pid: child.pid,
    send(keys) {
      child.stdin.write(keys);
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
}

// 選取的 tab：reverse video + bold
const selectedTabPattern = String.raw`\x1b\[7m\x1b\[1m`;
const enableMouse = '\x1b[?1000h\x1b[?1006h';
const disableMouse = '\x1b[?1000l\x1b[?1006l';

function assertMouseReportingRestored(output) {
  assert.ok(output.includes(enableMouse), 'mouse reporting was never enabled');
  assert.ok(output.lastIndexOf(disableMouse) > output.lastIndexOf(enableMouse), 'mouse reporting was not disabled on exit');
}

function toolUseLine(index, summary) {
  const timestamp = new Date(Date.parse('2026-10-10T01:10:00.000Z') + index * 1000).toISOString();
  const content = [{ type: 'tool_use', id: `toolu_step_${index}`, name: 'Bash', input: { command: summary } }];
  return `${JSON.stringify({ type: 'assistant', timestamp, message: { content } })}\n`;
}

function appendSteps(agentPath, from, to) {
  let text = '';
  for (let index = from; index < to; index += 1) {
    text += toolUseLine(index, `step ${String(index).padStart(2, '0')}`);
  }
  fs.appendFileSync(agentPath, text);
}

// 只有 Explore 還在跑：開啟時選它
function getExploreAgentPath(transcriptPath) {
  return path.join(path.dirname(transcriptPath), fixtureSessionId, 'subagents', 'agent-a111explore.jsonl');
}

function getChildPid(parentPid) {
  const result = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
  const pid = Number(result.stdout.trim().split('\n')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function selectedLabels(output) {
  const labels = [];
  for (const match of output.matchAll(new RegExp(`${selectedTabPattern}\\[[●✓] ([^\\]]+)\\]`, 'g'))) {
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
      await pty.waitForOutput(/\[● Explore\]/);
      pty.send('\x1b[C');
      await pty.waitForOutput(new RegExp(`${selectedTabPattern}\\[✓ general-purpose: Write the README\\]`));
      pty.send('1');
      await sleep(300);
      assert.equal(selectedLabels(pty.session.output).at(-1), 'general-purpose: Write the README');
      pty.send('\x1b[D');
      await sleep(150);
      pty.send('\x1b[D');
      await pty.waitForOutput(new RegExp(`${selectedTabPattern}\\[✓ fork\\]`));
      pty.send('q');
      assert.equal(await pty.exited, 0);
      assert.deepEqual(selectedLabels(pty.session.output), ['Explore', 'general-purpose: Write the README', 'Explore', 'fork']);
      assert.ok(pty.session.output.includes('\x1b[?1049h'));
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assert.ok(pty.session.output.includes('\x1b[?25h'));
      assertMouseReportingRestored(pty.session.output);
      assert.doesNotMatch(pty.session.output, /38;2;|48;2;/);
    } finally {
      pty.kill();
    }
  });

  test('Esc closes right away with exit 0', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      await pty.waitForOutput(/\[● Explore\]/);
      const sentAtMs = Date.now();
      pty.send('\x1b');
      assert.equal(await pty.exited, 0);
      assert.ok(pty.session.exitedAtMs - sentAtMs < 400, `took ${pty.session.exitedAtMs - sentAtMs} ms`);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assertMouseReportingRestored(pty.session.output);
    } finally {
      pty.kill();
    }
  });

  test('Ctrl+C exits 0 and restores the terminal', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      await pty.waitForOutput(/\[● Explore\]/);
      pty.send('\x03');
      assert.equal(await pty.exited, 0);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assert.ok(pty.session.output.includes('\x1b[?25h'));
      assertMouseReportingRestored(pty.session.output);
    } finally {
      pty.kill();
    }
  });

  test('SIGTERM exits 0 and turns mouse reporting off', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      await pty.waitForOutput(/\[● Explore\]/);
      const viewerPid = getChildPid(pty.pid);
      assert.ok(viewerPid !== null, 'could not find the viewer process under script');
      process.kill(viewerPid, 'SIGTERM');
      assert.equal(await pty.exited, 0);
      assertMouseReportingRestored(pty.session.output);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
    } finally {
      pty.kill();
    }
  });

  test('an uncaught exception still turns mouse reporting off before exiting 1', { timeout: 20_000 }, async () => {
    // 用 --import 預載一個晚一點才丟例外的 module，模擬 viewer 執行中出錯
    const throwerPath = path.join(temporaryRoot, 'throw-later.mjs');
    fs.writeFileSync(throwerPath, "setTimeout(() => { throw new Error('boom from test'); }, 800);\n");
    const environment = isolatedEnvironment({ NODE_OPTIONS: `--import=${pathToFileURL(throwerPath).href}` });
    const pty = startInPty(['--session', copyFixtureSession()], { environment });
    try {
      await pty.waitForOutput(/\[● Explore\]/);
      assert.equal(await pty.exited, 1);
      assertMouseReportingRestored(pty.session.output);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assert.match(pty.session.output, /boom from test/);
    } finally {
      pty.kill();
    }
  });

  test('scrolling pauses follow, counts new lines, keeps per-tab positions and End resumes', { timeout: 30_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const agentPath = getExploreAgentPath(transcriptPath);
    appendSteps(agentPath, 0, 40);
    // rows 16 → body 12 行：第 2–13 行，footer 在第 15 行
    const pty = startInPty(['--session', transcriptPath], { rows: 16 });
    const body = (lines) => lines.slice(2, 14);
    const footer = (lines) => lines[15] ?? '';
    // fixture 的第一個事件是 thinking，第二個是 Grep emitKeypressEvents
    const isAtOldest = (lines) => /thinking\.\.\.$/.test(body(lines)[0] ?? '') && /emitKeypressEvents$/.test(body(lines)[1] ?? '');
    try {
      let screen = await pty.waitForScreen((lines) => /step 39$/.test(body(lines).at(-1) ?? ''), 'follow shows step 39');
      assert.doesNotMatch(footer(screen), /new/);

      pty.send('\x1b[A');
      screen = await pty.waitForScreen((lines) => /↓ 0 new/.test(footer(lines)), 'paused footer');
      assert.match(body(screen).at(-1), /step 38$/);
      assert.match(footer(screen), /↑\/↓ PgUp\/PgDn scroll {2}End follow {2}q close/);

      appendSteps(agentPath, 40, 42);
      screen = await pty.waitForScreen((lines) => /↓ 2 new/.test(footer(lines)), '2 new lines while paused');
      assert.match(body(screen).at(-1), /step 38$/);

      pty.send('\x1b[<64;10;5M');
      screen = await pty.waitForScreen((lines) => /step 35$/.test(body(lines).at(-1) ?? ''), 'wheel up moves 3 lines');
      assert.match(footer(screen), /↓ 2 new/);
      pty.send('\x1b[<65;10;5M');
      screen = await pty.waitForScreen((lines) => /step 38$/.test(body(lines).at(-1) ?? ''), 'wheel down moves 3 lines');

      pty.send('\x1b[H');
      screen = await pty.waitForScreen(isAtOldest, 'Home shows the oldest event');
      assert.match(footer(screen), /↓ 2 new/);
      pty.send('\x1b[A');
      await sleep(200);
      assert.ok(isAtOldest(pty.getScreenLines()), 'up at the top stays at the oldest event');

      pty.send('\x1b[C');
      screen = await pty.waitForScreen((lines) => /\[✓ general-purpose: Write the README\]/.test(lines[0]) && !/new/.test(footer(lines)), 'other tab follows');
      pty.send('\x1b[D');
      screen = await pty.waitForScreen(isAtOldest, 'Explore keeps its position');
      assert.match(footer(screen), /↓ 2 new/);

      pty.send('\x1b[F');
      screen = await pty.waitForScreen((lines) => /step 41$/.test(body(lines).at(-1) ?? '') && !/new/.test(footer(lines)), 'End resumes follow');
      appendSteps(agentPath, 42, 43);
      screen = await pty.waitForScreen((lines) => /step 42$/.test(body(lines).at(-1) ?? ''), 'follow picks up the next line');
      assert.doesNotMatch(footer(screen), /new/);

      pty.send('\x1b[5~');
      screen = await pty.waitForScreen((lines) => /↓ 0 new/.test(footer(lines)), 'PgUp pauses');
      pty.send('\x1b[6~\x1b[6~');
      screen = await pty.waitForScreen((lines) => /step 42$/.test(body(lines).at(-1) ?? '') && !/new/.test(footer(lines)), 'PgDn back to the bottom resumes follow');

      pty.send('q');
      assert.equal(await pty.exited, 0);
      assertMouseReportingRestored(pty.session.output);
    } finally {
      pty.kill();
    }
  });

  test('the viewer never closes on its own and adds a tab when a new agent file appears', { timeout: 20_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const pty = startInPty(['--session', transcriptPath], { columns: 200 });
    try {
      await pty.waitForOutput(/\[● Explore\]/);
      await sleep(3000);
      assert.equal(pty.session.exitCode, null);
      const subagentsDirectory = path.join(path.dirname(transcriptPath), fixtureSessionId, 'subagents');
      fs.writeFileSync(path.join(subagentsDirectory, 'agent-e555late.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan next step' }));
      fs.writeFileSync(
        path.join(subagentsDirectory, 'agent-e555late.jsonl'),
        `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T01:30:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_late', name: 'Glob', input: { pattern: '**/*.mjs' } }] } })}\n`,
      );
      await pty.waitForOutput(/\[● Plan\]/, 3000);
      assert.equal(pty.session.exitCode, null);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });
});
