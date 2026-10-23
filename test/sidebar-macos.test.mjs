import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countClaudeAncestors,
  createProcessInfoReader,
  parseKernBoottime,
  parsePsOutput,
  readBootTimeSeconds,
  readProcessInfo,
  runHook,
  runSystemCommand,
  totalBudgetMs,
} from '../hooks/sidebar-hook.mjs';

// macOS 分支在 Linux 上用假的 ps／sysctl 輸出測：platform 與執行外部指令的函式都從參數注入
const testDirectory = dirname(fileURLToPath(import.meta.url));
const startPayloadText = readFileSync(join(testDirectory, 'fixtures', 'sidebar', 'subagent-start.json'), 'utf8');
const testPaneId = 'w1:pMac';

const temporaryDirectories = [];
function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'sidebar-macos-test-'));
  temporaryDirectories.push(directory);
  return directory;
}
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createCommandRecorder(outputByBinary) {
  const calls = [];
  const runCommand = (binaryPath, argumentList, timeoutMs) => {
    calls.push({ binaryPath, argumentList, timeoutMs });
    return outputByBinary[binaryPath] ?? null;
  };
  return { calls, runCommand };
}

// 一個 pane：ghostty → claude（完整路徑）→ zsh（Bash tool 的 shell）→ claude（巢狀的 claude -p）→ sh → node（hook）
const nestedPsOutput = [
  '    1     0 /sbin/launchd',
  '  501     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
  '  600   501 /Users/me/.local/bin/claude',
  '  610   600 /bin/zsh',
  '  620   610 claude',
  '  690   620 /bin/sh',
  '  700   690 node',
  '',
].join('\n');

describe('parsePsOutput', () => {
  test('a full path keeps only the file name, and spaces in the name are kept', () => {
    const processTable = parsePsOutput([
      '  600   501 /Users/me/.local/bin/claude',
      '  630   600 /Applications/My Tool.app/Contents/MacOS/My Tool',
      '12345     1 claude',
    ].join('\n'));
    assert.deepEqual(processTable.get(600), { command: 'claude', parentProcessId: 501 });
    assert.deepEqual(processTable.get(630), { command: 'My Tool', parentProcessId: 600 });
    assert.deepEqual(processTable.get(12345), { command: 'claude', parentProcessId: 1 });
  });

  test('(p_comm) of another user\'s process loses its parentheses; a zombie stays <defunct>', () => {
    const processTable = parsePsOutput('  640     1 (claude)\n  650   640 <defunct>\n');
    assert.equal(processTable.get(640).command, 'claude');
    assert.equal(processTable.get(650).command, '<defunct>');
  });

  test('empty or missing output gives an empty table', () => {
    assert.equal(parsePsOutput('').size, 0);
    assert.equal(parsePsOutput('\n\n').size, 0);
    assert.equal(parsePsOutput(null).size, 0);
  });

  test('lines it cannot read are skipped, the rest still parse', () => {
    const processTable = parsePsOutput([
      '  PID  PPID COMM',
      'abc def ghi',
      '12',
      '  12 34',
      '\u0000\u0001ÿ garbage',
      '  -5    1 claude',
      '  77    1 claude',
    ].join('\n'));
    assert.deepEqual([...processTable.keys()], [77]);
  });
});

describe('parseKernBoottime', () => {
  test('reads sec from the sysctl output', () => {
    assert.equal(parseKernBoottime('{ sec = 1791608737, usec = 123456 } Thu Oct  8 09:12:17 2026\n'), 1_791_608_737n);
  });

  test('usec alone is not taken for sec, whatever the order', () => {
    assert.equal(parseKernBoottime('{ usec = 123456 }'), null);
    assert.equal(parseKernBoottime('{ usec = 123456, sec = 1791608737 }'), 1_791_608_737n);
  });

  test('missing, empty or zero values give null', () => {
    assert.equal(parseKernBoottime(''), null);
    assert.equal(parseKernBoottime(null), null);
    assert.equal(parseKernBoottime('{ sec = 0, usec = 5 }'), null);
    assert.equal(parseKernBoottime('kern.boottime: unknown oid'), null);
  });
});

describe('macOS wiring, with injected platform and commands', () => {
  test('the boot time comes from one sysctl call with an absolute path and a timeout inside the budget', () => {
    const recorder = createCommandRecorder({ '/usr/sbin/sysctl': '{ sec = 1791608737, usec = 5 } Thu Oct  8 09:12:17 2026\n' });
    const readText = () => {
      throw new Error('/proc must not be read on macOS');
    };
    assert.equal(readBootTimeSeconds({ platform: 'darwin', readText, runCommand: recorder.runCommand }), 1_791_608_737n);
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.calls[0].binaryPath, '/usr/sbin/sysctl');
    assert.deepEqual(recorder.calls[0].argumentList, ['-n', 'kern.boottime']);
    assert.ok(recorder.calls[0].timeoutMs > 0 && recorder.calls[0].timeoutMs < totalBudgetMs);
  });

  test('a failed sysctl falls back to null (the fixed seq base)', () => {
    const recorder = createCommandRecorder({});
    assert.equal(readBootTimeSeconds({ platform: 'darwin', runCommand: recorder.runCommand }), null);
  });

  test('the process tree comes from a single ps snapshot, not one spawn per level', () => {
    const recorder = createCommandRecorder({ '/bin/ps': nestedPsOutput });
    const readInfo = createProcessInfoReader({ platform: 'darwin', runCommand: recorder.runCommand });
    assert.equal(countClaudeAncestors(700, readInfo), 2);
    assert.equal(countClaudeAncestors(610, readInfo), 1);
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.calls[0].binaryPath, '/bin/ps');
    assert.deepEqual(recorder.calls[0].argumentList, ['-A', '-o', 'pid=,ppid=,comm=']);
    assert.ok(recorder.calls[0].timeoutMs > 0 && recorder.calls[0].timeoutMs < totalBudgetMs);
  });

  test('a claude wrapper right above claude still counts as one group', () => {
    const recorder = createCommandRecorder({
      '/bin/ps': '  600   501 /Users/me/bin/claude\n  601   600 /Users/me/.local/bin/claude\n  690   601 /bin/sh\n  700   690 node\n',
    });
    assert.equal(countClaudeAncestors(700, createProcessInfoReader({ platform: 'darwin', runCommand: recorder.runCommand })), 1);
  });

  test('a failed ps counts no claude, the same as an unreadable /proc', () => {
    const recorder = createCommandRecorder({});
    assert.equal(countClaudeAncestors(700, createProcessInfoReader({ platform: 'darwin', runCommand: recorder.runCommand })), 0);
  });

  test('Linux keeps reading /proc and never runs ps', () => {
    const recorder = createCommandRecorder({ '/bin/ps': nestedPsOutput });
    assert.equal(createProcessInfoReader({ platform: 'linux', runCommand: recorder.runCommand }), readProcessInfo);
    assert.deepEqual(recorder.calls, []);
  });
});

describe('runSystemCommand', () => {
  test('returns stdout, or null when the command fails, is missing or runs too long', () => {
    assert.equal(runSystemCommand('/bin/sh', ['-c', 'printf "a b"'], 2000), 'a b');
    assert.equal(runSystemCommand('/bin/sh', ['-c', 'echo partial; exit 3'], 2000), null);
    assert.equal(runSystemCommand('/nonexistent/ps', [], 2000), null);
    const startMs = Date.now();
    assert.equal(runSystemCommand('/bin/sh', ['-c', 'exec sleep 5'], 100), null);
    assert.ok(Date.now() - startMs < 2000, 'the timeout kills the command');
  });
});

describe('runHook state folder by platform', () => {
  function createDependencies(platform, temporaryDirectory) {
    const herdrCalls = [];
    return {
      herdrCalls,
      dependencies: {
        now: () => 1_000_000,
        monotonicNs: () => 1n,
        readBootTimeSeconds: () => 1_790_000_000n,
        platform,
        temporaryDirectory: () => temporaryDirectory,
        runHerdr: (binaryPath, argumentList) => {
          herdrCalls.push(argumentList);
        },
        isExecutable: () => true,
        queryPaneAgentSession: () => null,
        countClaudeAncestors: () => 1,
        readFileTail: () => ({ isMissing: true }),
        deadlineMs: Number.POSITIVE_INFINITY,
      },
    };
  }
  const environmentWithout = { HERDR_PANE_ID: testPaneId, HERDR_BIN_PATH: '/fake/herdr' };

  test('macOS without XDG_RUNTIME_DIR writes into os.tmpdir()', () => {
    const temporaryDirectory = createTemporaryDirectory();
    const { dependencies, herdrCalls } = createDependencies('darwin', temporaryDirectory);
    const result = runHook(startPayloadText, environmentWithout, dependencies);
    assert.equal(result.action, 'reported');
    assert.equal(herdrCalls.length, 1);
    assert.ok(existsSync(join(temporaryDirectory, 'subagent-watch', `pane-${testPaneId}.json`)));
  });

  test('macOS with XDG_RUNTIME_DIR uses it and leaves os.tmpdir() alone', () => {
    const temporaryDirectory = createTemporaryDirectory();
    const runtimeDirectory = createTemporaryDirectory();
    const { dependencies } = createDependencies('darwin', temporaryDirectory);
    const result = runHook(startPayloadText, { ...environmentWithout, XDG_RUNTIME_DIR: runtimeDirectory }, dependencies);
    assert.equal(result.action, 'reported');
    assert.ok(existsSync(join(runtimeDirectory, 'subagent-watch', `pane-${testPaneId}.json`)));
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });

  test('Linux without XDG_RUNTIME_DIR still skips and never falls back to os.tmpdir()', () => {
    const temporaryDirectory = createTemporaryDirectory();
    const { dependencies, herdrCalls } = createDependencies('linux', temporaryDirectory);
    assert.deepEqual(runHook(startPayloadText, environmentWithout, dependencies), { action: 'skipped', reason: 'no-runtime-directory' });
    assert.deepEqual(herdrCalls, []);
    assert.deepEqual(readdirSync(temporaryDirectory), []);
  });

  test('the folder checks apply to the os.tmpdir() fallback too', () => {
    const temporaryDirectory = createTemporaryDirectory();
    mkdirSync(join(temporaryDirectory, 'subagent-watch'));
    chmodSync(join(temporaryDirectory, 'subagent-watch'), 0o777);
    const { dependencies, herdrCalls } = createDependencies('darwin', temporaryDirectory);
    assert.deepEqual(runHook(startPayloadText, environmentWithout, dependencies), { action: 'skipped', reason: 'unsafe-state-directory' });
    assert.deepEqual(herdrCalls, []);
  });
});
