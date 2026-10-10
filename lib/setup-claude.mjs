import path from 'node:path';

// 五個 event 都掛同一個 command（hook 依 hook_event_name 分辨）。舊版只裝前兩個：重跑 setup 時每個 event 各自檢查，缺的補上、已有的原地更新，不會重複；
// SessionStart 讓 popup 一開 session 就知道 pane 對到哪個 session，Stop 每回合清掉收不到 SubagentStop 的 sub（見 hooks/sidebar-hook.mjs）；
// 回合因 API 錯誤結束時不觸發 Stop、改觸發 StopFailure（官方 hooks 文件），額度用完的那一回合要靠它清
export const hookEventNames = ['SubagentStart', 'SubagentStop', 'SessionStart', 'Stop', 'StopFailure'];
export const hookScriptName = 'sidebar-hook.mjs';
export const hookTimeoutSeconds = 5;

// hook command 由 Claude Code 交給 shell 執行，路徑包在雙引號裡；這幾個字元在雙引號裡仍會被 shell 解讀
const unsafeShellCharacterPattern = /["$`\\]/;

export function buildHookCommand(pluginRoot) {
  if (unsafeShellCharacterPattern.test(pluginRoot)) {
    throw new Error(`plugin path contains a character that breaks a shell command (" $ \` \\): ${pluginRoot}`);
  }
  const launcherPath = path.join(pluginRoot, 'bin', 'run.sh');
  const hookPath = path.join(pluginRoot, 'hooks', hookScriptName);
  return `sh "${launcherPath}" "${hookPath}"`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Claude Code 的 hook 物件沒有可放識別用的欄位（官方文件只列 type、command、timeout、if、statusMessage 等），只能認 command 的寫法。
// 只比對子字串 sidebar-hook.mjs 的話，別的工具剛好同名的 hook 也會被改掉或刪掉；這裡要求整個 command 就是本 plugin 會寫的兩種格式
const launcherCommandPattern = /^sh "(\/[^"]*)\/bin\/run\.sh" "(\/[^"]*)\/hooks\/sidebar-hook\.mjs"$/;
// 有 launcher 之前的舊寫法（當時文件教使用者手動加）：node 絕對路徑加 hook 絕對路徑，中間一個空白、沒有引號；要認得才能原地升級
const legacyCommandPattern = /^\/\S*\/node \/\S*\/hooks\/sidebar-hook\.mjs$/;

export function isSidebarHookCommand(command) {
  if (typeof command !== 'string') {
    return false;
  }
  const launcherMatch = launcherCommandPattern.exec(command);
  if (launcherMatch !== null) {
    return launcherMatch[1] === launcherMatch[2];
  }
  return legacyCommandPattern.test(command);
}

export function isSidebarHook(hook) {
  return isPlainObject(hook) && isSidebarHookCommand(hook.command);
}

// 結構不是預期的樣子就整個不碰：寧可請使用者手動加，也不要把看不懂的設定改壞
export function findSettingsShapeProblem(settings) {
  if (!isPlainObject(settings)) {
    return 'settings.json is not a JSON object';
  }
  if (settings.hooks === undefined) {
    return null;
  }
  if (!isPlainObject(settings.hooks)) {
    return '"hooks" in settings.json is not an object';
  }
  for (const eventName of hookEventNames) {
    const groups = settings.hooks[eventName];
    if (groups !== undefined && !Array.isArray(groups)) {
      return `"hooks.${eventName}" in settings.json is not an array`;
    }
  }
  return null;
}

function describeEventChange(previousGroups, nextGroups, hadSidebarHook) {
  if (JSON.stringify(previousGroups) === JSON.stringify(nextGroups)) {
    return 'unchanged';
  }
  return hadSidebarHook ? 'updated' : 'added';
}

// 每個 event 只留一筆指向 sidebar-hook.mjs 的 hook：已經有就原地換成新的 command，其他 hook 與 group 原封不動
export function installSidebarHooks(settings, command) {
  const nextSettings = structuredClone(settings);
  nextSettings.hooks ??= {};
  const changes = {};
  for (const eventName of hookEventNames) {
    const previousGroups = nextSettings.hooks[eventName] ?? [];
    let hasSidebarHook = false;
    const nextGroups = [];
    for (const group of previousGroups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isSidebarHook)) {
        nextGroups.push(group);
        continue;
      }
      const keptHooks = [];
      for (const hook of group.hooks) {
        if (!isSidebarHook(hook)) {
          keptHooks.push(hook);
        } else if (!hasSidebarHook) {
          hasSidebarHook = true;
          keptHooks.push({ ...hook, type: 'command', command, timeout: hookTimeoutSeconds });
        }
      }
      if (keptHooks.length > 0) {
        nextGroups.push({ ...group, hooks: keptHooks });
      }
    }
    const hadSidebarHook = hasSidebarHook;
    if (!hasSidebarHook) {
      nextGroups.push({ hooks: [{ type: 'command', command, timeout: hookTimeoutSeconds }] });
    }
    nextSettings.hooks[eventName] = nextGroups;
    changes[eventName] = describeEventChange(previousGroups, nextGroups, hadSidebarHook);
  }
  return { settings: nextSettings, changes };
}

export function removeSidebarHooks(settings) {
  const nextSettings = structuredClone(settings);
  const changes = {};
  let removedCount = 0;
  for (const eventName of hookEventNames) {
    const previousGroups = nextSettings.hooks?.[eventName];
    if (!Array.isArray(previousGroups)) {
      changes[eventName] = 'absent';
      continue;
    }
    let eventRemovedCount = 0;
    const nextGroups = [];
    for (const group of previousGroups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isSidebarHook)) {
        nextGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter((hook) => !isSidebarHook(hook));
      eventRemovedCount += group.hooks.length - keptHooks.length;
      if (keptHooks.length > 0) {
        nextGroups.push({ ...group, hooks: keptHooks });
      }
    }
    removedCount += eventRemovedCount;
    changes[eventName] = eventRemovedCount > 0 ? 'removed' : 'absent';
    // 沒拿掉東西的 event 原封不動：使用者自己留的空陣列也不要動，否則什麼都沒移除還是會重寫檔案
    if (eventRemovedCount === 0) {
      continue;
    }
    if (nextGroups.length === 0) {
      delete nextSettings.hooks[eventName];
    } else {
      nextSettings.hooks[eventName] = nextGroups;
    }
  }
  if (removedCount > 0 && isPlainObject(nextSettings.hooks) && Object.keys(nextSettings.hooks).length === 0) {
    delete nextSettings.hooks;
  }
  return { settings: nextSettings, changes, removedCount };
}

// 照原檔的縮排、換行字元與結尾換行寫回去，沒改到的部分 diff 才會是空的
export function detectJsonIndent(text) {
  const match = /^\{\r?\n([ \t]+)\S/.exec(text);
  if (match !== null) {
    return match[1];
  }
  // 原本就寫成一行（而且不是空物件）的檔案維持一行
  const isSingleLine = !text.trim().includes('\n');
  return isSingleLine && !/^\s*\{\s*\}\s*$/.test(text) ? 0 : 2;
}

export function formatSettings(settings, originalText) {
  const indent = originalText === '' ? 2 : detectJsonIndent(originalText);
  const hasTrailingNewline = originalText === '' || originalText.endsWith('\n');
  const endOfLine = originalText.includes('\r\n') ? '\r\n' : '\n';
  // JSON.stringify 會把字串裡的換行跳脫成 \n，輸出裡真正的換行只有縮排用的那些，可以整批換成 CRLF
  const body = JSON.stringify(settings, null, indent).replaceAll('\n', endOfLine);
  return `${body}${hasTrailingNewline ? endOfLine : ''}`;
}
