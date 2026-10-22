import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { getClaudeConfigDirectory, getClaudeProjectsDirectory, getClaudeSettingsPath } from '../lib/claude-config.mjs';
import { resolveHerdrBinPath } from '../lib/herdr.mjs';
import { resolveRuntimeDirectory } from '../lib/runtime-directory.mjs';

test('CLAUDE_CONFIG_DIR moves both projects/ and settings.json', () => {
  const environment = { CLAUDE_CONFIG_DIR: '/data/claude-config', HOME: '/home/someone' };
  assert.equal(getClaudeConfigDirectory(environment), '/data/claude-config');
  assert.equal(getClaudeProjectsDirectory(environment), '/data/claude-config/projects');
  assert.equal(getClaudeSettingsPath(environment), '/data/claude-config/settings.json');
});

test('without CLAUDE_CONFIG_DIR the Claude config lives in $HOME/.claude', () => {
  const environment = { CLAUDE_CONFIG_DIR: '', HOME: '/home/someone' };
  assert.equal(getClaudeProjectsDirectory(environment), path.join('/home/someone', '.claude', 'projects'));
  assert.equal(getClaudeSettingsPath(environment), path.join('/home/someone', '.claude', 'settings.json'));
});

test('HERDR_BIN_PATH is used as is when set', () => {
  const checkedPaths = [];
  const isExecutable = (filePath) => {
    checkedPaths.push(filePath);
    return true;
  };
  assert.equal(resolveHerdrBinPath({ HERDR_BIN_PATH: '/somewhere/herdr', PATH: '/usr/bin' }, isExecutable), '/somewhere/herdr');
  assert.deepEqual(checkedPaths, []);
});

test('without HERDR_BIN_PATH the first executable herdr on PATH is used, or null', () => {
  const isExecutable = (filePath) => filePath === '/b/herdr' || filePath === '/c/herdr';
  assert.equal(resolveHerdrBinPath({ PATH: '/a::/b:/c' }, isExecutable), '/b/herdr');
  assert.equal(resolveHerdrBinPath({ PATH: '/a' }, isExecutable), null);
  assert.equal(resolveHerdrBinPath({}, isExecutable), null);
});

// hook 與 popup 共用這個函式：兩邊選到同一個資料夾，popup 才找得到 pane 對照檔
test('the runtime directory is XDG_RUNTIME_DIR on both platforms when it is set', () => {
  const temporaryDirectory = '/var/folders/ab/xyz/T';
  for (const platform of ['linux', 'darwin']) {
    assert.equal(resolveRuntimeDirectory({ environment: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform, temporaryDirectory }), '/run/user/1000');
  }
});

test('without XDG_RUNTIME_DIR only macOS falls back to os.tmpdir(); Linux gets null instead of a shared /tmp', () => {
  const temporaryDirectory = '/var/folders/ab/xyz/T';
  assert.equal(resolveRuntimeDirectory({ environment: {}, platform: 'darwin', temporaryDirectory }), temporaryDirectory);
  assert.equal(resolveRuntimeDirectory({ environment: { XDG_RUNTIME_DIR: '' }, platform: 'darwin', temporaryDirectory }), temporaryDirectory);
  assert.equal(resolveRuntimeDirectory({ environment: {}, platform: 'linux', temporaryDirectory: '/tmp' }), null);
  assert.equal(resolveRuntimeDirectory({ environment: { XDG_RUNTIME_DIR: '' }, platform: 'linux', temporaryDirectory: '/tmp' }), null);
  assert.equal(resolveRuntimeDirectory({ environment: {}, platform: 'darwin', temporaryDirectory: '' }), null);
});
