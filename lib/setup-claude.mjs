import path from 'node:path';

export const hookEventNames = ['SubagentStart', 'SubagentStop'];
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

export function isSidebarHook(hook) {
  return isPlainObject(hook) && typeof hook.command === 'string' && hook.command.includes(hookScriptName);
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

// 照原檔的縮排與結尾換行寫回去，沒改到的部分 diff 才會是空的
export function detectJsonIndent(text) {
  const match = /^\{\r?\n([ \t]+)\S/.exec(text);
  return match === null ? 2 : match[1];
}

export function formatSettings(settings, originalText) {
  const indent = originalText === '' ? 2 : detectJsonIndent(originalText);
  const hasTrailingNewline = originalText === '' || originalText.endsWith('\n');
  return `${JSON.stringify(settings, null, indent)}${hasTrailingNewline ? '\n' : ''}`;
}
