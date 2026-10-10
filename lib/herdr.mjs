import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export function isExecutableFile(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// herdr 文件要 plugin 一律用 HERDR_BIN_PATH 呼叫正在跑的 herdr；只有不在 herdr 底下（CLI、hook 外的環境）才退回 PATH
export function resolveHerdrBinPath(environment = process.env, isExecutable = isExecutableFile) {
  const configuredPath = environment.HERDR_BIN_PATH;
  if (typeof configuredPath === 'string' && configuredPath !== '') {
    return configuredPath;
  }
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    // 空字串與相對路徑都是相對於 cwd；hook 的 cwd 是使用者正在開的 repo，PATH 有 `node_modules/.bin` 之類的項目時會執行 repo 裡放的 herdr
    if (!path.isAbsolute(directory)) {
      continue;
    }
    const candidate = path.join(directory, 'herdr');
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const herdrNotFoundMessage = 'herdr not found: HERDR_BIN_PATH is not set and there is no herdr on PATH';
