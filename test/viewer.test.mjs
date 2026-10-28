import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import { displayWidth } from '../lib/text.mjs';

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
  // 選取的 tab 顯示全名，其他只有編號
  assert.equal(lines[0], '1 running · 3 done │   [1 ● Explore] 2 3 4');
  // 第一次開啟選最新的跑中 sub：fixture 只有 Explore 還在跑
  assert.match(result.stdout, /Grep {8}emitKeypressEvents/);
  // 多行指令保留換行，第二行縮排到摘要欄
  assert.match(result.stdout, /Bash {8}git status --short\n {22}ls src\n/);
  assert.match(result.stdout, /thinking\.\.\./);
  assert.doesNotMatch(result.stdout, /file body/);
  assert.match(lines[22], /session 11111111/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('--once --demo prints the summary, the selected demo tab in full and the other tabs as numbers', () => {
  const result = runViewer(['--once', '--demo']);
  assert.equal(result.status, 0, result.stderr);
  const [tabBar] = result.stdout.split('\n');
  assert.equal(tabBar, '2 running · 1 done │   1 2 [3 ● general-purpose]');
  assert.match(result.stdout, /demo data/);
  assert.doesNotMatch(result.stdout, /closing in/);
});

test('demo.mjs is a thin wrapper around viewer.mjs --demo', () => {
  const result = runViewer(['--once'], { scriptPath: demoPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], '2 running · 1 done │   1 2 [3 ● general-purpose]');
  assert.match(result.stdout, /demo data/);
});

test('inside a plugin popup without any pane information the viewer explains it found no session', () => {
  const result = runViewer(['--once'], {
    environment: isolatedEnvironment({
      HERDR_PLUGIN_ID: 'subagent.watch',
      HERDR_BIN_PATH: '/nonexistent/herdr',
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
      CLAUDE_CONFIG_DIR: configDirectory,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /session 11111111 \(guessed: latest session\)/);
  assert.match(result.stdout, /\[1 ● Explore\]/);
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

// SGR 左鍵 press＋release，和 herdr 轉給 popup 的一樣；x、y 是 1-based
function click(x, y) {
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
}

// needle 第一個字元在畫面上的欄（1-based，和 SGR mouse 座標同一套）；寬字元算 2 欄，和 viewer 畫的一致
function columnOf(line, needle) {
  const index = line.indexOf(needle);
  assert.ok(index !== -1, `${needle} not in ${line}`);
  return displayWidth(line.slice(0, index)) + 1;
}

// count 個跑中的 sub agent，名稱 w1…wN、照編號依序啟動：測兩位數的 tab 編號
function writeManyAgentsSession(name, count) {
  const sessionId = 'bbbbbbbb-0000-4000-8000-000000000000';
  const projectDirectory = path.join(temporaryRoot, name, '-tmp-many');
  const subagentsDirectory = path.join(projectDirectory, sessionId, 'subagents');
  fs.mkdirSync(subagentsDirectory, { recursive: true });
  const nowMs = Date.now();
  fs.writeFileSync(path.join(projectDirectory, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: new Date(nowMs).toISOString(), message: { content: 'x' } })}\n`);
  for (let number = 1; number <= count; number += 1) {
    const id = `m${String(number).padStart(3, '0')}`;
    const timestamp = new Date(nowMs - (count - number) * 1000).toISOString();
    fs.writeFileSync(path.join(subagentsDirectory, `agent-${id}.meta.json`), JSON.stringify({ agentType: `w${number}`, description: `task ${number}` }));
    const content = [{ type: 'tool_use', id: `t${id}`, name: 'Bash', input: { command: `echo ${number}` } }];
    fs.writeFileSync(path.join(subagentsDirectory, `agent-${id}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp, message: { content } })}\n`);
  }
  return path.join(projectDirectory, `${sessionId}.jsonl`);
}

function selectedLabels(output) {
  const labels = [];
  for (const match of output.matchAll(new RegExp(`${selectedTabPattern}\\[\\d+ [●✓] ([^\\]]+)\\]`, 'g'))) {
    if (labels.at(-1) !== match[1]) {
      labels.push(match[1]);
    }
  }
  return labels;
}

async function waitUntil(predicate, description, timeoutMs = 5000) {
  const startMs = Date.now();
  while (!predicate()) {
    if (Date.now() - startMs > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

describe('interactive mode in a pty', { skip: !hasScript && 'util-linux script is not available' }, () => {
  test('left/right cycle through tabs, a digit jumps to that tab number, q exits 0 and restores the terminal', { timeout: 20_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const pty = startInPty(['--session', transcriptPath]);
    try {
      await pty.waitForOutput(/\[1 ● Explore\]/);
      pty.send('\x1b[C');
      await pty.waitForOutput(new RegExp(`${selectedTabPattern}\\[2 ✓ general-purpose: Write the README\\]`));
      // 4 個 tab：1 不可能是兩位數的開頭，馬上跳，不用等
      pty.send('1');
      await waitUntil(() => selectedLabels(pty.session.output).length >= 3, '1 jumps to the first tab');
      pty.send('\x1b[D');
      await waitUntil(() => selectedLabels(pty.session.output).length >= 4, 'left wraps around');
      pty.send('3');
      await waitUntil(() => selectedLabels(pty.session.output).length >= 5, '3 jumps to the third tab');
      pty.send('q');
      assert.equal(await pty.exited, 0);
      assert.deepEqual(selectedLabels(pty.session.output), ['Explore', 'general-purpose: Write the README', 'Explore', 'fork', 'general-purpose: Run the slow te…']);
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
      await pty.waitForOutput(/\[1 ● Explore\]/);
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
      await pty.waitForOutput(/\[1 ● Explore\]/);
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
      await pty.waitForOutput(/\[1 ● Explore\]/);
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
      await pty.waitForOutput(/\[1 ● Explore\]/);
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
      // 最上面按 ↑ 不動：接著按 ↓ 應該剛好往下一行；↑ 若跑去別的位置（例如恢復 follow），↓ 就不會停在第二個事件
      pty.send('\x1b[A');
      pty.send('\x1b[B');
      await pty.waitForScreen((lines) => /emitKeypressEvents$/.test(body(lines)[0] ?? ''), 'up at the top stays, then down moves one row');
      pty.send('\x1b[A');
      await pty.waitForScreen(isAtOldest, 'back at the oldest event');

      pty.send('\x1b[C');
      screen = await pty.waitForScreen((lines) => /\[2 ✓ general-purpose: Write the README\]/.test(lines[0]) && !/new/.test(footer(lines)), 'other tab follows');
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

  test('long commands wrap, the arrow keys move by screen rows and ↓ N new counts rows', { timeout: 30_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const agentPath = getExploreAgentPath(transcriptPath);
    appendSteps(agentPath, 0, 20);
    // columns 60 → 摘要欄 38 欄：8 + 90 + 5 = 103 欄折成 3 行（38、38、27）
    const longCommand = (label) => `${label} ${'-'.repeat(90)} tail`;
    fs.appendFileSync(agentPath, toolUseLine(20, longCommand('wrap-a')));
    const pty = startInPty(['--session', transcriptPath], { columns: 60, rows: 16 });
    const body = (lines) => lines.slice(2, 14);
    const footer = (lines) => lines[15] ?? '';
    try {
      let screen = await pty.waitForScreen((lines) => /^ {22}-+ tail$/.test(body(lines).at(-1) ?? ''), 'follow shows the last wrapped row');
      assert.match(body(screen).at(-3), /Bash {8}wrap-a -+$/);
      assert.match(body(screen).at(-2), /^ {22}-{38}$/);
      assert.match(body(screen).at(-4), /step 19$/);

      pty.send('\x1b[A');
      screen = await pty.waitForScreen((lines) => /↓ 0 new/.test(footer(lines)), 'up pauses');
      assert.match(body(screen).at(-1), /^ {22}-{38}$/);
      assert.match(body(screen).at(-2), /wrap-a -+$/);

      fs.appendFileSync(agentPath, toolUseLine(21, longCommand('wrap-b')));
      screen = await pty.waitForScreen((lines) => /↓ 3 new/.test(footer(lines)), 'a 3-row event counts as 3 new rows');
      appendSteps(agentPath, 22, 23);
      screen = await pty.waitForScreen((lines) => /↓ 4 new/.test(footer(lines)), 'one more short event');
      assert.match(body(screen).at(-1), /^ {22}-{38}$/);

      pty.send('\x1b[F');
      screen = await pty.waitForScreen((lines) => /step 22$/.test(body(lines).at(-1) ?? '') && !/new/.test(footer(lines)), 'End resumes follow');
      assert.match(body(screen).at(-2), /^ {22}-+ tail$/);
      assert.match(body(screen).at(-4), /Bash {8}wrap-b -+$/);
      for (const line of screen) {
        assert.ok(line.length <= 60, line);
      }

      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('clicking a number on the tab bar selects that tab; clicks elsewhere are ignored', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      let screen = await pty.waitForScreen((lines) => lines[0] === '1 running · 3 done │   [1 ● Explore] 2 3 4', 'the first tab bar');
      const third = columnOf(screen[0], ' 3 4') + 1;
      // 第 2 行同一欄、tab 列上的空白都不算點到
      pty.send(click(third, 2));
      pty.send(click(third - 1, 1));
      pty.send(click(third, 1));
      screen = await pty.waitForScreen((lines) => /^1 running · 3 done │ {3}1 2 \[3 ✓ general-purpose: Run the slow te…\] 4$/.test(lines[0]), 'the third tab after a click');
      pty.send(click(columnOf(screen[0], '│   1 ') + 4, 1));
      await pty.waitForScreen((lines) => lines[0] === '1 running · 3 done │   [1 ● Explore] 2 3 4', 'the first tab after a click');
      pty.send('q');
      assert.equal(await pty.exited, 0);
      // 點到第 2 行與空白的那兩下沒有切換
      assert.deepEqual(selectedLabels(pty.session.output), ['Explore', 'general-purpose: Run the slow te…', 'Explore']);
      assertMouseReportingRestored(pty.session.output);
    } finally {
      pty.kill();
    }
  });

  test('clicking ◀ / ▶ on a narrow tab bar moves to the previous / next tab', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()], { columns: 34 });
    try {
      let screen = await pty.waitForScreen((lines) => lines[0] === '1 running · 3 done │   [1 ● Ex…] ▶', 'only the selected tab fits');
      pty.send(click(columnOf(screen[0], '▶'), 1));
      screen = await pty.waitForScreen((lines) => lines[0] === '1 running · 3 done │ ◀ [2 ✓ ge…] ▶', 'the next tab after ▶');
      pty.send(click(columnOf(screen[0], '▶'), 1));
      screen = await pty.waitForScreen((lines) => lines[0] === '1 running · 3 done │ ◀ [3 ✓ ge…] ▶', 'the third tab after ▶');
      pty.send(click(columnOf(screen[0], '◀'), 1));
      await pty.waitForScreen((lines) => lines[0] === '1 running · 3 done │ ◀ [2 ✓ ge…] ▶', 'back to the second tab after ◀');
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('two-digit tab numbers: a second digit jumps at once, a lone 1 waits, other keys cancel', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', writeManyAgentsSession('many-agents', 12)], { columns: 120 });
    const tabBar = () => pty.getScreenLines()[0] ?? '';
    const isSelected = (number) => (lines) => new RegExp(`\\[${number} ● w${number}\\]`).test(lines[0] ?? '');
    try {
      await pty.waitForScreen(isSelected(12), 'the newest tab selected first');
      pty.send('1');
      pty.send('1');
      await pty.waitForScreen(isSelected(11), '11 after typing 1 then 1');
      // 1 還可能是 10–12 的開頭：等 600ms 沒有下一位才跳
      const sentAtMs = Date.now();
      pty.send('1');
      await pty.waitForScreen(isSelected(1), 'tab 1 after the wait');
      assert.ok(Date.now() - sentAtMs >= 550, `jumped after ${Date.now() - sentAtMs}ms`);
      // 等待中按 → 會丟掉輸入的 1、照常切到下一個 tab，之後也不會再跳回 1
      pty.send('\x1b[C');
      pty.send('\x1b[C');
      await pty.waitForScreen(isSelected(3), 'right arrows after tab 1');
      pty.send('1');
      pty.send('\x1b[C');
      await pty.waitForScreen(isSelected(4), 'right arrow cancels the half-typed 1');
      // 13 超出範圍、0 開頭都不跳
      pty.send('13');
      pty.send('0');
      await new Promise((resolve) => {
        setTimeout(resolve, 900);
      });
      assert.ok(isSelected(4)(pty.getScreenLines()), tabBar());
      pty.send('7');
      await pty.waitForScreen(isSelected(7), 'a digit still works after ignored input');
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('the viewer never closes on its own and adds a tab when a new agent file appears', { timeout: 20_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const pty = startInPty(['--session', transcriptPath], { columns: 200 });
    try {
      await pty.waitForOutput(/\[1 ● Explore\]/);
      // 先讓所有 sub 都結束：之後還能看到新 tab，代表全部結束後 viewer 仍在跑、照常更新
      fs.appendFileSync(getExploreAgentPath(transcriptPath), `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-10T01:20:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'toolu_handback', name: 'SubagentHandback', input: { message: 'done' } }] },
      })}\n`);
      await pty.waitForScreen((lines) => /^0 running · 4 done/.test(lines[0] ?? ''), 'every sub agent done');
      assert.equal(pty.session.exitCode, null);
      const subagentsDirectory = path.join(path.dirname(transcriptPath), fixtureSessionId, 'subagents');
      fs.writeFileSync(path.join(subagentsDirectory, 'agent-e555late.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan next step' }));
      fs.writeFileSync(
        path.join(subagentsDirectory, 'agent-e555late.jsonl'),
        `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T01:30:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_late', name: 'Glob', input: { pattern: '**/*.mjs' } }] } })}\n`,
      );
      await pty.waitForScreen((lines) => /^1 running · 4 done │ {3}\[1 ✓ Explore\] 2 3 4 5$/.test(lines[0] ?? ''), 'the new tab as number 5', 3000);
      assert.equal(pty.session.exitCode, null);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });
});

// poc1 的形狀：meta、tool 名稱、指令裡夾 OSC 52（寫剪貼簿）、OSC 8（假連結）、清畫面、8-bit CSI、bidi override
function writeHostileSession(name) {
  const sessionId = 'aaaaaaaa-0000-4000-8000-000000000000';
  const projectDirectory = path.join(temporaryRoot, name, '-tmp-x');
  const subagentsDirectory = path.join(projectDirectory, sessionId, 'subagents');
  fs.mkdirSync(subagentsDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(projectDirectory, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', timestamp, message: { content: 'x' } })}\n`);
  const agents = [
    { id: 'a1', meta: { agentType: 'general-purpose', description: 'X\u001b]52;c;cHduZWQ=\u0007Y' } },
    { id: 'a2', meta: { agentType: 'general-purpose', description: '\u001b[2J\u009b31m‮evil' } },
    { id: 'a3', meta: { agentType: 'Exp\u001b]8;;https://evil.example/\u001b\\click\u001b]8;;\u001b\\', description: 'd' } },
  ];
  for (const agent of agents) {
    fs.writeFileSync(path.join(subagentsDirectory, `agent-${agent.id}.meta.json`), JSON.stringify(agent.meta));
    const content = [{ type: 'tool_use', id: `t${agent.id}`, name: 'Bash\u001b]52;c;QQ==\u0007', input: { command: 'echo \u001b]52;c;QUJD\u0007 \u009b2J \u001b[31mred⁦' } }];
    fs.writeFileSync(path.join(subagentsDirectory, `agent-${agent.id}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp, message: { content } })}\n`);
  }
  return path.join(projectDirectory, `${sessionId}.jsonl`);
}

const foreignControlPattern = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}]/u;

test('--once strips every escape sequence, C1 control and bidi character that came from the transcript', () => {
  const result = runViewer(['--once', '--session', writeHostileSession('hostile-once')]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, foreignControlPattern);
  assert.match(result.stdout, /│ {3}1 2 \[3 ● Exp click\]\n/);
  // 8-bit CSI（U+009B）只剝它自己，後面的 2J、31m 是普通文字；description 做的 tab 名稱在 pty 測試切過去看
  assert.match(result.stdout, /Bash {8}echo {3}2J red/);
  assert.match(result.stdout, /session aaaaaaaa/);
});

test('--once that fails prints a sanitized error to stderr and exits 1', () => {
  // 用 --import 預載：讀 stdout 寬度時丟例外，runOnce 的 promise 會 reject
  const preloadPath = path.join(temporaryRoot, 'throwing-columns.mjs');
  fs.writeFileSync(preloadPath, `Object.defineProperty(process.stdout, 'columns', {
  get() {
    throw new Error('stdout broke \\u001b]52;c;cHduZWQ=\\u0007 \\u009b2J \\u202eevil');
  },
});
`);
  const result = runViewer(['--once', '--session', copyFixtureSession()], {
    environment: isolatedEnvironment({ NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /stdout broke/);
  assert.doesNotMatch(result.stderr, foreignControlPattern, JSON.stringify(result.stderr.match(foreignControlPattern)?.[0]));
});

test('--once whose cleanup throws prints a sanitized error to stderr and exits 1', () => {
  // 用 --import 預載：watcher 關掉資料夾監看時丟例外，stop() 會在畫面印出後丟出來
  const preloadPath = path.join(temporaryRoot, 'throwing-watch-close.mjs');
  fs.writeFileSync(preloadPath, `import fs from 'node:fs';
const realWatch = fs.watch;
fs.watch = (...argumentList) => {
  const watcher = realWatch(...argumentList);
  watcher.close = () => {
    throw new Error('close broke \\u001b]52;c;cHduZWQ=\\u0007 \\u009b2J \\u202eevil');
  };
  return watcher;
};
`);
  const result = runViewer(['--once', '--session', copyFixtureSession()], {
    environment: isolatedEnvironment({ NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /\[1 ● Explore\]/);
  assert.match(result.stderr, /close broke/);
  assert.doesNotMatch(result.stderr, foreignControlPattern, JSON.stringify(result.stderr.match(foreignControlPattern)?.[0]));
});

// 假 herdr：每次 `pane get` 讀 responsePath 的內容，等 delayPath 指定的毫秒數，開始與結束都記在 logPath
function writeScriptedHerdr(name, { response, delayMs = 0 }) {
  const directory = path.join(temporaryRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  const paths = {
    binPath: path.join(directory, 'herdr'),
    responsePath: path.join(directory, 'response.json'),
    delayPath: path.join(directory, 'delay'),
    logPath: path.join(directory, 'calls.log'),
    pidPath: path.join(directory, 'pid'),
  };
  fs.writeFileSync(paths.responsePath, JSON.stringify(response));
  fs.writeFileSync(paths.delayPath, String(delayMs));
  fs.writeFileSync(paths.logPath, '');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const paths = ${JSON.stringify(paths)};
fs.writeFileSync(paths.pidPath, String(process.pid));
fs.appendFileSync(paths.logPath, 'start ' + Date.now() + '\\n');
setTimeout(() => {
  process.stdout.write(fs.readFileSync(paths.responsePath, 'utf8'));
  fs.appendFileSync(paths.logPath, 'end ' + Date.now() + '\\n');
}, Number(fs.readFileSync(paths.delayPath, 'utf8')));
`;
  fs.writeFileSync(paths.binPath, script, { mode: 0o755 });
  return paths;
}

function claudePaneResponse(cwd, sessionId) {
  const pane = { pane_id: 'w1:p1', agent: 'claude', agent_status: 'working', cwd, foreground_cwd: cwd };
  if (sessionId !== null) {
    pane.agent_session = { agent: 'claude', kind: 'id', source: 'herdr:claude', value: sessionId };
  }
  return { id: 'cli:pane:get', result: { pane, type: 'pane_info' } };
}

const secondSessionId = '22222222-3333-4444-8555-666666666666';

// 同一個 cwd 底下兩個 session：fixture（Explore 等 4 個 sub）與只有一個 Plan sub 的第二個 session
function writeTwoSessions(name) {
  const configDirectory = path.join(temporaryRoot, `${name}-config`);
  const workDirectory = path.join(temporaryRoot, `${name}-work`);
  fs.mkdirSync(workDirectory, { recursive: true });
  const projectDirectory = path.join(configDirectory, 'projects', fs.realpathSync(workDirectory).replaceAll('/', '-'));
  fs.cpSync(fixtureProjectDirectory, projectDirectory, { recursive: true });
  const subagentsDirectory = path.join(projectDirectory, secondSessionId, 'subagents');
  fs.mkdirSync(subagentsDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(projectDirectory, `${secondSessionId}.jsonl`), `${JSON.stringify({ type: 'user', timestamp, message: { content: 'next' } })}\n`);
  fs.writeFileSync(path.join(subagentsDirectory, 'agent-b1plan.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Plan next step' }));
  fs.writeFileSync(
    path.join(subagentsDirectory, 'agent-b1plan.jsonl'),
    `${JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: 'toolu_plan', name: 'Glob', input: { pattern: '**/*.mjs' } }] } })}\n`,
  );
  return { configDirectory, workDirectory, projectDirectory };
}

function appendUserLine(transcriptPath, content) {
  fs.appendFileSync(transcriptPath, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content } })}\n`);
}

function popupEnvironment(herdrBinPath, { configDirectory, workDirectory }) {
  return isolatedEnvironment({
    HERDR_PLUGIN_ID: 'subagent.watch',
    HERDR_BIN_PATH: herdrBinPath,
    SUBAGENT_WATCH_PANE_ID: 'w1:p1',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p1', focused_pane_cwd: workDirectory }),
    CLAUDE_CONFIG_DIR: configDirectory,
  });
}

function readCallLog(logPath) {
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const [kind, timeText] = line.split(' ');
    return { kind, timeMs: Number(timeText) };
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('session lookup and terminal safety in a pty', { skip: !hasScript && 'util-linux script is not available' }, () => {
  test('only the app\'s own escape sequences reach the terminal', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', writeHostileSession('hostile-pty')]);
    try {
      await pty.waitForOutput(/\[3 ● Exp click\]/);
      await pty.waitForOutput(/echo {3}2J red/);
      // 用數字鍵切到另外兩個 tab，讓 description 做的名稱也畫出來
      pty.send('2');
      await pty.waitForOutput(/\[2 ● general-purpose: 31mevil\]/);
      pty.send('1');
      await pty.waitForOutput(/\[1 ● general-purpose: X Y\]/);
      pty.send('q');
      assert.equal(await pty.exited, 0);
      const ownSequencePattern = /\x1b\[(?:[0-9;]*m|H|2K|2J|\?25[hl]|\?1049[hl]|\?100[06][hl])/g;
      const leftover = pty.session.output.replace(ownSequencePattern, '').replace(/\r|\n/g, '');
      assert.doesNotMatch(leftover, foreignControlPattern, JSON.stringify(leftover.match(foreignControlPattern)?.[0]));
    } finally {
      pty.kill();
    }
  });

  test('a new session reported by herdr (/resume, claude restarted) replaces the one on screen', { timeout: 20_000 }, async () => {
    const sessions = writeTwoSessions('switch');
    const herdr = writeScriptedHerdr('switch-herdr', { response: claudePaneResponse(sessions.workDirectory, fixtureSessionId) });
    const pty = startInPty([], { columns: 160, environment: popupEnvironment(herdr.binPath, sessions) });
    try {
      await pty.waitForScreen((lines) => /\[1 ● Explore\]/.test(lines[0] ?? '') && lines.some((line) => /session 11111111 ─/.test(line)), 'first session');
      // herdr 回報的值變了就換，不看 transcript 寫入時間
      fs.writeFileSync(herdr.responsePath, JSON.stringify(claudePaneResponse(sessions.workDirectory, secondSessionId)));
      const screen = await pty.waitForScreen((lines) => /\[1 ● Plan\]/.test(lines[0] ?? '') && lines.some((line) => /session 22222222 ─/.test(line)), 'second session');
      assert.doesNotMatch(screen[0], /Explore/);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('a guessed session is replaced once herdr reports the real one', { timeout: 20_000 }, async () => {
    const sessions = writeTwoSessions('guess-then-real');
    // 猜測取最新修改的 transcript：讓第二個 session 比較新，herdr 之後回報的是 fixture 那個
    const olderDate = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(sessions.projectDirectory, `${fixtureSessionId}.jsonl`), olderDate, olderDate);
    const herdr = writeScriptedHerdr('guess-herdr', { response: claudePaneResponse(sessions.workDirectory, null) });
    const pty = startInPty([], { columns: 160, environment: popupEnvironment(herdr.binPath, sessions) });
    try {
      await pty.waitForScreen((lines) => /\[1 ● Plan\]/.test(lines[0] ?? '') && lines.some((line) => /session 22222222 \(guessed: latest session\)/.test(line)), 'guessed session');
      fs.writeFileSync(herdr.responsePath, JSON.stringify(claudePaneResponse(sessions.workDirectory, fixtureSessionId)));
      const screen = await pty.waitForScreen((lines) => /\[1 ● Explore\]/.test(lines[0] ?? '') && lines.some((line) => /session 11111111 ─/.test(line)), 'real session');
      assert.ok(!screen.some((line) => /guessed/.test(line)));
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('herdr failing after /resume does not switch the screen to a guessed session', { timeout: 20_000 }, async () => {
    const sessions = writeTwoSessions('flap');
    // herdr 回報第二個 session；fixture session 寫得比較近，herdr 失敗退回去猜時會猜到它
    const secondTranscriptPath = path.join(sessions.projectDirectory, `${secondSessionId}.jsonl`);
    const olderDate = new Date(Date.now() - 60_000);
    fs.utimesSync(secondTranscriptPath, olderDate, olderDate);
    const herdr = writeScriptedHerdr('flap-herdr', { response: claudePaneResponse(sessions.workDirectory, secondSessionId) });
    const pty = startInPty([], { columns: 160, environment: popupEnvironment(herdr.binPath, sessions) });
    const isSecondSession = (lines) => /\[1 ● Plan\]/.test(lines[0] ?? '') && lines.some((line) => /── session 22222222 /.test(line));
    try {
      await pty.waitForScreen(isSecondSession, 'second session');
      // herdr 回不出 pane（和逾時一樣退回去猜）：等兩次查詢，畫面不能跳到猜的 fixture
      fs.writeFileSync(herdr.responsePath, 'not json');
      const callCount = readCallLog(herdr.logPath).filter((call) => call.kind === 'end').length;
      await waitUntil(() => readCallLog(herdr.logPath).filter((call) => call.kind === 'end').length >= callCount + 2, 'two failed herdr lookups', 10_000);
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      const screen = pty.getScreenLines();
      assert.ok(isSecondSession(screen), screen.join('\n'));
      assert.ok(!screen.some((line) => /guessed/.test(line)), screen.join('\n'));
      assert.doesNotMatch(stripAnsi(pty.session.output), /Explore/);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('another session in the same folder that keeps being written does not make the screen flap', { timeout: 30_000 }, async () => {
    const sessions = writeTwoSessions('stale-writer');
    // fixture session 在別的 pane 被 \`claude -c\` 接著寫；herdr 正確回報第二個 session
    const olderDate = new Date(Date.now() - 60_000);
    const fixtureTranscriptPath = path.join(sessions.projectDirectory, `${fixtureSessionId}.jsonl`);
    const secondTranscriptPath = path.join(sessions.projectDirectory, `${secondSessionId}.jsonl`);
    fs.utimesSync(fixtureTranscriptPath, olderDate, olderDate);
    const herdr = writeScriptedHerdr('stale-writer-herdr', { response: claudePaneResponse(sessions.workDirectory, secondSessionId) });
    const pty = startInPty([], { columns: 160, environment: popupEnvironment(herdr.binPath, sessions) });
    const isSecondSession = (lines) => /\[1 ● Plan\]/.test(lines[0] ?? '') && lines.some((line) => /── session 22222222 /.test(line));
    const countFinishedLookups = () => readCallLog(herdr.logPath).filter((call) => call.kind === 'end').length;
    try {
      await pty.waitForScreen(isSecondSession, 'second session');
      // 每次查詢之間輪流寫兩個 transcript：下一次查詢時，剛寫的那個 mtime 一定比較新
      for (let round = 0; round < 4; round += 1) {
        const finishedLookups = countFinishedLookups();
        appendUserLine(round % 2 === 0 ? fixtureTranscriptPath : secondTranscriptPath, `round ${round}`);
        await waitUntil(() => countFinishedLookups() > finishedLookups, `lookup after round ${round}`, 10_000);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      const screen = pty.getScreenLines();
      assert.ok(isSecondSession(screen), screen.join('\n'));
      assert.doesNotMatch(stripAnsi(pty.session.output), /Explore/);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('a lookup that keeps throwing shows one sanitized line in the status line and clears once it recovers', { timeout: 30_000 }, async () => {
    const sessions = writeTwoSessions('lookup-error');
    const herdr = writeScriptedHerdr('lookup-error-herdr', { response: claudePaneResponse(sessions.workDirectory, fixtureSessionId) });
    const failFlagPath = path.join(temporaryRoot, 'lookup-error-flag');
    const failLogPath = path.join(temporaryRoot, 'lookup-error.log');
    fs.writeFileSync(failLogPath, '');
    // 用 --import 預載：flag 存在時讀 CLAUDE_CONFIG_DIR 就丟例外，模擬查詢本身出錯（例 HOME 沒設時 os.homedir() 失敗）
    const preloadPath = path.join(temporaryRoot, 'throwing-environment.mjs');
    fs.writeFileSync(preloadPath, `import fs from 'node:fs';
const realEnvironment = process.env;
process.env = new Proxy(realEnvironment, {
  get(target, key) {
    if (key === 'CLAUDE_CONFIG_DIR' && fs.existsSync(${JSON.stringify(failFlagPath)})) {
      fs.appendFileSync(${JSON.stringify(failLogPath)}, 'fail\\n');
      throw new Error('config broke \\u001b]52;c;cHduZWQ=\\u0007\\nsecond line \\u009b2J');
    }
    return Reflect.get(target, key);
  },
});
`);
    const environment = { ...popupEnvironment(herdr.binPath, sessions), NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` };
    const pty = startInPty([], { columns: 160, environment });
    const statusLine = (lines) => lines.find((line) => /^── session 11111111/.test(line)) ?? '';
    try {
      await pty.waitForScreen((lines) => /\[1 ● Explore\]/.test(lines[0] ?? '') && /session 11111111 ─/.test(statusLine(lines)), 'first session');
      fs.writeFileSync(failFlagPath, '');
      const screen = await pty.waitForScreen((lines) => /session 11111111 · session lookup failed: config broke/.test(statusLine(lines)), 'lookup error in the status line');
      assert.match(statusLine(screen), /session lookup failed: config broke second line/);
      assert.match(screen[0], /\[1 ● Explore\]/);
      // 再失敗兩次：同一個錯誤不重畫，輸出裡只出現一次
      await waitUntil(() => fs.readFileSync(failLogPath, 'utf8').split('\n').filter(Boolean).length >= 3, 'two more failed lookups', 10_000);
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });
      assert.equal(stripAnsi(pty.session.output).split('session lookup failed').length - 1, 1);
      fs.rmSync(failFlagPath);
      await pty.waitForScreen((lines) => /session 11111111 ─/.test(statusLine(lines)), 'status line cleared after recovery', 10_000);
      pty.send('q');
      assert.equal(await pty.exited, 0);
      const ownSequencePattern = /\x1b\[(?:[0-9;]*m|H|2K|2J|\?25[hl]|\?1049[hl]|\?100[06][hl])/g;
      const leftover = pty.session.output.replace(ownSequencePattern, '').replace(/\r|\n/g, '');
      assert.doesNotMatch(leftover, foreignControlPattern, JSON.stringify(leftover.match(foreignControlPattern)?.[0]));
    } finally {
      pty.kill();
    }
  });

  test('q closes right away while herdr is stuck, and the stuck herdr is killed', { timeout: 20_000 }, async () => {
    const sessions = writeTwoSessions('stuck');
    const herdr = writeScriptedHerdr('stuck-herdr', { response: claudePaneResponse(sessions.workDirectory, fixtureSessionId), delayMs: 60_000 });
    const pty = startInPty([], { environment: popupEnvironment(herdr.binPath, sessions) });
    try {
      await pty.waitForOutput(/Looking up the Claude Code session for this pane/);
      await waitUntil(() => readCallLog(herdr.logPath).length === 1, 'herdr to be called');
      const herdrPid = Number(fs.readFileSync(herdr.pidPath, 'utf8'));
      const sentAtMs = Date.now();
      pty.send('q');
      assert.equal(await pty.exited, 0);
      assert.ok(pty.session.exitedAtMs - sentAtMs < 1000, `took ${pty.session.exitedAtMs - sentAtMs} ms`);
      assertMouseReportingRestored(pty.session.output);
      await waitUntil(() => !isProcessAlive(herdrPid), 'stuck herdr to be killed');
    } finally {
      pty.kill();
    }
  });

  test('only one herdr lookup runs at a time even when it takes longer than the recheck interval', { timeout: 20_000 }, async () => {
    const sessions = writeTwoSessions('single-flight');
    // 第一次查詢 2.5 秒（比 2 秒的重查間隔長），之後立即回應
    const herdr = writeScriptedHerdr('single-flight-herdr', { response: claudePaneResponse(sessions.workDirectory, fixtureSessionId), delayMs: 2500 });
    const pty = startInPty([], { environment: popupEnvironment(herdr.binPath, sessions) });
    try {
      await waitUntil(() => readCallLog(herdr.logPath).length >= 1, 'first lookup');
      fs.writeFileSync(herdr.delayPath, '0');
      await waitUntil(() => readCallLog(herdr.logPath).filter((call) => call.kind === 'start').length >= 2, 'second lookup', 10_000);
      const calls = readCallLog(herdr.logPath);
      assert.deepEqual(calls.slice(0, 3).map((call) => call.kind), ['start', 'end', 'start']);
      assert.ok(calls[2].timeMs >= calls[1].timeMs);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('a new tab sorted before the selected one does not move the selection', { timeout: 20_000 }, async () => {
    const transcriptPath = copyFixtureSession();
    const pty = startInPty(['--session', transcriptPath], { columns: 200 });
    try {
      await pty.waitForOutput(new RegExp(`${selectedTabPattern}\\[1 ● Explore\\]`));
      const subagentsDirectory = path.join(path.dirname(transcriptPath), fixtureSessionId, 'subagents');
      fs.writeFileSync(path.join(subagentsDirectory, 'agent-0000early.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'Started first' }));
      fs.writeFileSync(
        path.join(subagentsDirectory, 'agent-0000early.jsonl'),
        `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T00:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'toolu_early', name: 'Glob', input: { pattern: '*' } }] } })}\n`,
      );
      const screen = await pty.waitForScreen((lines) => /│ {3}1 \[2 ● Explore\] 3 4 5$/.test(lines[0] ?? ''), 'the earlier tab appears first');
      assert.match(screen[0], /^2 running/);
      const lastFrame = pty.session.output.split('\x1b[H').at(-1);
      assert.deepEqual(selectedLabels(lastFrame), ['Explore']);
      pty.send('q');
      assert.equal(await pty.exited, 0);
    } finally {
      pty.kill();
    }
  });

  test('SIGHUP restores the terminal and exits 0', { timeout: 20_000 }, async () => {
    const pty = startInPty(['--session', copyFixtureSession()]);
    try {
      await pty.waitForOutput(/\[1 ● Explore\]/);
      const viewerPid = getChildPid(pty.pid);
      assert.ok(viewerPid !== null, 'could not find the viewer process under script');
      process.kill(viewerPid, 'SIGHUP');
      assert.equal(await pty.exited, 0);
      assertMouseReportingRestored(pty.session.output);
      assert.ok(pty.session.output.includes('\x1b[?1049l'));
      assert.ok(pty.session.output.includes('\x1b[?25h'));
    } finally {
      pty.kill();
    }
  });
});
