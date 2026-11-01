// CI 的 changes job 用：改動只有溝通用 md 時印 false，job 層跳過 test。
// 用法：git diff --name-only <base> <head> | node scripts/ci-needs-test.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const communicationDocumentPattern = /^(?:[^/]+|docs\/.+)\.md$/;

export function needsTest(changedFiles) {
  // 空清單（force push 前後相同、diff 取不到）不能當成沒改動，寧可多跑
  if (changedFiles.length === 0) {
    return true;
  }
  return changedFiles.some((changedFile) => !communicationDocumentPattern.test(changedFile));
}

export function parseFileList(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fileList = process.argv.length > 2 ? process.argv.slice(2) : parseFileList(fs.readFileSync(0, 'utf8'));
  process.stdout.write(`${needsTest(fileList)}\n`);
}
