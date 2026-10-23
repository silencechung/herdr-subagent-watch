import os from 'node:os';

// hook 寫、popup 讀的 subagent-watch 資料夾放在這裡；兩邊一定要用同一個函式選，不然 popup 找不到 pane 對照檔。
// macOS 沒有 XDG_RUNTIME_DIR，改用 os.tmpdir()（$TMPDIR，/var/folders/…/T，每個使用者一個、0700）。
// Linux 沒有 XDG_RUNTIME_DIR 時不退回 os.tmpdir()：那通常是共用的 /tmp，別的使用者能先佔掉資料夾名稱
export function resolveRuntimeDirectory({
  environment = process.env,
  platform = process.platform,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  const runtimeDirectory = environment.XDG_RUNTIME_DIR;
  if (typeof runtimeDirectory === 'string' && runtimeDirectory !== '') {
    return runtimeDirectory;
  }
  if (platform === 'darwin' && typeof temporaryDirectory === 'string' && temporaryDirectory !== '') {
    return temporaryDirectory;
  }
  return null;
}
