// 舊版的側邊欄 hook（hooks/sidebar-hook.mjs）已經拿掉；setup 與 remove 只負責把舊版寫進 Claude Code settings.json 的 hook 清掉。
// 舊版掛在這五個 event 上（更早的版本只掛前兩個）
export const hookEventNames = ['SubagentStart', 'SubagentStop', 'SessionStart', 'Stop', 'StopFailure'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Claude Code 的 hook 物件沒有可放識別用的欄位（官方文件只列 type、command、timeout、if、statusMessage 等），只能認 command 的寫法。
// 只比對子字串 sidebar-hook.mjs 的話，別的工具剛好同名的 hook 也會被改掉或刪掉；這裡要求整個 command 就是本 plugin 會寫的兩種格式
const launcherCommandPattern = /^sh "(\/[^"]*)\/bin\/run\.sh" "(\/[^"]*)\/hooks\/sidebar-hook\.mjs"$/;
// 有 launcher 之前的舊寫法（當時文件教使用者手動加）：node 絕對路徑加 hook 絕對路徑，中間一個空白、沒有引號；一樣要清掉
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

// 結構不是預期的樣子就整個不碰：寧可請使用者手動刪，也不要把看不懂的設定改壞
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
