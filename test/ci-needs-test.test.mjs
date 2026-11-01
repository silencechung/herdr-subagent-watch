import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { needsTest, parseFileList } from '../scripts/ci-needs-test.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/ci-needs-test.mjs', import.meta.url));

test('根目錄的 md 都不需要跑 test', () => {
  assert.equal(needsTest(['CLAUDE.md', 'README.md', 'README.zh-TW.md', 'CHANGELOG.md']), false);
});

test('docs 底下的 md 不需要跑 test', () => {
  assert.equal(needsTest(['docs/x.md', 'docs/sub/y.zh-TW.md']), false);
});

test('混到程式碼就要跑 test', () => {
  assert.equal(needsTest(['README.md', 'lib/a.mjs']), true);
});

test('非根目錄也非 docs 的 md 要跑 test', () => {
  assert.equal(needsTest(['src/content/x.md']), true);
});

test('.github、scripts、test 底下的檔要跑 test', () => {
  assert.equal(needsTest(['.github/workflows/test.yml']), true);
  assert.equal(needsTest(['scripts/ci-needs-test.mjs']), true);
});

test('空清單要跑 test', () => {
  assert.equal(needsTest([]), true);
});

test('parseFileList 去掉空行與前後空白', () => {
  assert.deepEqual(parseFileList('a.md\n\n  docs/b.md \n'), ['a.md', 'docs/b.md']);
  assert.deepEqual(parseFileList(''), []);
});

test('CLI 從 stdin 讀清單並印 true／false', () => {
  const run = (input) => spawnSync(process.execPath, [scriptPath], { input, encoding: 'utf8' }).stdout;
  assert.equal(run('README.md\ndocs/x.md\n'), 'false\n');
  assert.equal(run('README.md\nlib/a.mjs\n'), 'true\n');
  assert.equal(run(''), 'true\n');
});
