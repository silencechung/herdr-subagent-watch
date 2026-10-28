import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { resolveHerdrBinPath } from '../lib/herdr.mjs';
import {
  applyHerdrSetup,
  buildKeyBlockLines,
  markerEnd,
  markerStart,
  parseTableHeader,
  removeHerdrSetup,
  stripComment,
} from '../lib/setup-herdr.mjs';

const baseConfig = [
  'onboarding = false',
  '',
  '[ui]',
  'status_indicators = "symbols"',
  '',
  '[[keys.command]]',
  'key = "prefix+y"',
  'type = "popup"',
  'command = "yazi"',
  '',
].join('\n');

const tableWithoutClaude = `${baseConfig}
[ui.sidebar.agents.rows_by_agent] # per agent rows
codex = [
  ["state_icon", "workspace"],
  ["agent"],
]
`;

// 舊版 setup 寫的區塊：快捷鍵一塊、側邊欄 rows 一塊（沒有 rows table 時連 header 一起加，有的話插在 header 下面）
const markerStartLine = `${markerStart} (added by subagent.watch.setup; subagent.watch.remove deletes this block)`;
const keyBlock = buildKeyBlockLines().join('\n');
const claudeRows = [
  'claude = [',
  '  ["state_icon", "machine", "workspace", "tab"],',
  '  ["agent"],',
  '  [{ token = "$sub1", bold = true, dim = false }],',
  ']',
];
const legacyRowsBlockWithHeader = [markerStartLine, '[ui.sidebar.agents.rows_by_agent]', ...claudeRows, markerEnd].join('\n');

const legacyFullInstall = `${baseConfig}${keyBlock}\n${legacyRowsBlockWithHeader}\n`;

const legacyRowsInUserTable = tableWithoutClaude.replace(
  '[ui.sidebar.agents.rows_by_agent] # per agent rows\n',
  `[ui.sidebar.agents.rows_by_agent] # per agent rows\n${[markerStartLine, ...claudeRows, markerEnd].join('\n')}\n`,
);

// 更舊版寫的五格 $sub1～$sub5
const legacyFiveTokens = legacyFullInstall.replace(
  '  [{ token = "$sub1", bold = true, dim = false }],\n',
  [1, 2, 3, 4, 5].map((index) => `  [{ token = "$sub${index}", bold = true, dim = false }],\n`).join(''),
);

const handWrittenRows = `${baseConfig}
[ui.sidebar.agents.rows_by_agent]
claude = [
  ["agent"],
  [{ token = "$sub1" }],
]
`;

function countMarkers(text) {
  return text.split('\n').filter((line) => line.startsWith(markerStart)).length;
}

describe('line helpers', () => {
  test('comments are stripped only outside strings', () => {
    assert.equal(stripComment('key = "a#b" # note'), 'key = "a#b" ');
    assert.equal(stripComment("key = 'x#y'"), "key = 'x#y'");
    assert.equal(stripComment('key = "esc\\"#" # c'), 'key = "esc\\"#" ');
  });

  test('table headers are recognised, array rows are not', () => {
    assert.deepEqual(parseTableHeader('[ui.sidebar.agents.rows_by_agent] # x'), { name: 'ui.sidebar.agents.rows_by_agent', isArray: false });
    assert.deepEqual(parseTableHeader('[[keys.command]]'), { name: 'keys.command', isArray: true });
    assert.equal(parseTableHeader('  ["agent"],'), null);
    assert.equal(parseTableHeader('[[keys.command]'), null);
  });
});

describe('setup', () => {
  test('a fresh config gets only the key, inside markers, and no sidebar rows', () => {
    const { text, analysis } = applyHerdrSetup(baseConfig);
    assert.equal(analysis.key.state, 'missing');
    assert.equal(analysis.removedRowsBlockCount, 0);
    assert.equal(text, `${baseConfig}${keyBlock}\n`);
    assert.equal(countMarkers(text), 1);
    assert.match(text, /\[\[keys\.command\]\]\nkey = "prefix\+\."\ntype = "plugin_action"\ncommand = "subagent\.watch\.open"/);
    assert.doesNotMatch(text, /\$sub|rows_by_agent/);
  });

  test('an older install keeps its key and loses its sidebar rows block, header included', () => {
    const { text, analysis } = applyHerdrSetup(legacyFullInstall);
    assert.equal(analysis.key.state, 'configured');
    assert.equal(analysis.removedRowsBlockCount, 1);
    assert.equal(text, `${baseConfig}${keyBlock}\n`);
  });

  test('older rows inserted under the user\'s own rows table are removed, the user\'s header and rows stay', () => {
    const { text, analysis } = applyHerdrSetup(legacyRowsInUserTable);
    assert.equal(analysis.removedRowsBlockCount, 1);
    assert.equal(text, `${tableWithoutClaude}${keyBlock}\n`);
  });

  test('the five $sub rows of an even older version are removed too', () => {
    assert.equal(applyHerdrSetup(legacyFiveTokens).text, `${baseConfig}${keyBlock}\n`);
  });

  test('$sub1 rows added by hand (no markers) are left alone and reported', () => {
    const { text, leftoverRowLineNumbers } = applyHerdrSetup(handWrittenRows);
    assert.ok(text.startsWith(handWrittenRows));
    assert.deepEqual(leftoverRowLineNumbers, [14]);
  });

  test('prefix+. bound to something else is reported and not touched', () => {
    const occupied = baseConfig.replace('key = "prefix+y"', 'key = "prefix+."');
    const { text, analysis } = applyHerdrSetup(occupied);
    assert.equal(analysis.key.state, 'occupied');
    assert.equal(analysis.key.lineNumber, 7);
    assert.equal(text, occupied);
  });

  test('prefix+. used by a built-in action in [keys] also counts as taken', () => {
    const { analysis } = applyHerdrSetup(`[keys]\nrename_tab = "prefix+."\n`);
    assert.equal(analysis.key.state, 'occupied');
  });

  test('setup twice gives the same text', () => {
    for (const original of [baseConfig, tableWithoutClaude, legacyFullInstall, legacyRowsInUserTable, handWrittenRows, '']) {
      const once = applyHerdrSetup(original).text;
      assert.equal(applyHerdrSetup(once).text, once);
    }
  });

  test('an unterminated marker block changes nothing', () => {
    const broken = `${baseConfig}${markerStart}\n[ui.sidebar.agents.rows_by_agent]\n`;
    const result = applyHerdrSetup(broken);
    assert.equal(result.text, broken);
    assert.match(result.error, /never ends/);
  });
});

describe('remove', () => {
  test('setup then remove gives back the original text byte for byte', () => {
    for (const original of [baseConfig, tableWithoutClaude, '', 'a = 1\r\n[ui]\r\nb = 2\r\n']) {
      const installed = applyHerdrSetup(original).text;
      const removed = removeHerdrSetup(installed);
      assert.equal(removed.error, null);
      assert.equal(removed.text, original);
    }
  });

  test('remove takes out both blocks of an older install', () => {
    assert.equal(removeHerdrSetup(legacyFullInstall).text, baseConfig);
    assert.equal(removeHerdrSetup(legacyRowsInUserTable).text, tableWithoutClaude);
  });

  test('settings added by hand (no markers) are not removed but are reported', () => {
    const handWritten = `${handWrittenRows}[[keys.command]]\nkey = "prefix+."\ntype = "plugin_action"\ncommand = "subagent.watch.open"\n`;
    const result = removeHerdrSetup(handWritten);
    assert.equal(result.text, handWritten);
    assert.deepEqual(result.operations, []);
    assert.deepEqual(result.leftoverLineNumbers, [14, 19]);
  });

  test('an unterminated marker block removes nothing', () => {
    const broken = `${baseConfig}${markerStart}\n[[keys.command]]\nkey = "prefix+."\n`;
    const result = removeHerdrSetup(broken);
    assert.equal(result.text, broken);
    assert.match(result.error, /never ends/);
    assert.ok(result.error.includes(markerEnd));
  });
});

const herdrBinPath = resolveHerdrBinPath(process.env);
const canRunHerdr = herdrBinPath !== null && spawnSync(herdrBinPath, ['--version'], { encoding: 'utf8' }).status === 0;

describe('generated config passes the real `herdr config check`', { skip: !canRunHerdr && 'herdr is not available' }, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watch-herdr-check-'));
  after(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function checkConfig(name, text) {
    const configPath = path.join(temporaryRoot, `${name}.toml`);
    fs.writeFileSync(configPath, text);
    // config check 只讀檔案、不連 server；仍拿掉 socket 變數，確保碰不到正在跑的 herdr
    const environment = { ...process.env, HERDR_CONFIG_PATH: configPath };
    delete environment.HERDR_SOCKET_PATH;
    return spawnSync(herdrBinPath, ['config', 'check'], { env: environment, encoding: 'utf8' });
  }

  for (const [name, original] of [['fresh', baseConfig], ['empty', ''], ['upgraded-from-older-install', legacyFullInstall], ['upgraded-rows-in-user-table', legacyRowsInUserTable]]) {
    test(name, () => {
      const result = checkConfig(name, applyHerdrSetup(original).text);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /config: ok/);
    });
  }
});
