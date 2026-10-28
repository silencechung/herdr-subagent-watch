// 沒有 TOML parser（不裝套件），只做保守的逐行文字處理：看不懂就跳過、請使用者手動貼，寫完再交給 `herdr config check` 把關。
// 已知不處理：多行字串（""" / '''）裡出現像 table header 或 key 的內容會被誤判，最壞結果是跳過或被 config check 擋下還原。

export const markerStart = '# >>> subagent.watch';
export const markerEnd = '# <<< subagent.watch';
export const keyBinding = 'prefix+.';
export const openActionId = 'subagent.watch.open';

const markerStartLine = `${markerStart} (added by subagent.watch.setup; subagent.watch.remove deletes this block)`;
const tableHeaderPattern = /^\s*(\[\[?)\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*(\]\]?)\s*$/;
// 未驗證 herdr 是否接受 period 這個別名；保守起見一起當成同一個鍵，只會讓 setup 多跳過，不會蓋掉別人的設定
const keyBindingPattern = /["'](?:prefix\+\.|prefix\+period)["']/;
const keyLinePattern = /^\s*key\s*=\s*["'](?:prefix\+\.|prefix\+period)["']\s*$/;
const openCommandLinePattern = /^\s*command\s*=\s*["']subagent\.watch\.open["']\s*$/;

export function buildKeyBlockLines() {
  return [
    markerStartLine,
    '[[keys.command]]',
    `key = "${keyBinding}"`,
    'type = "plugin_action"',
    `command = "${openActionId}"`,
    'description = "sub agent viewer"',
    markerEnd,
  ];
}

export function buildManualKeySnippet() {
  return [
    '[[keys.command]]',
    'key = "<a free key, e.g. prefix+alt+s>"',
    'type = "plugin_action"',
    `command = "${openActionId}"`,
    'description = "sub agent viewer"',
  ];
}

// 只拿掉不在字串裡的 # 之後的內容；一行內的 basic／literal string 都認得
export function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === null) {
      if (character === '#') {
        return line.slice(0, index);
      }
      if (character === '"' || character === "'") {
        quote = character;
      }
    } else if (quote === '"' && character === '\\') {
      index += 1;
    } else if (character === quote) {
      quote = null;
    }
  }
  return line;
}

export function parseTableHeader(line) {
  const match = tableHeaderPattern.exec(stripComment(line));
  if (match === null || match[1].length !== match[3].length) {
    return null;
  }
  return { name: match[2].replace(/\s+/g, ''), isArray: match[1] === '[[' };
}

export function splitLines(text) {
  const endOfLine = text.includes('\r\n') ? '\r\n' : '\n';
  if (text === '') {
    return { lines: [], endOfLine, hasTrailingNewline: true };
  }
  const lines = text.split(/\r?\n/);
  const hasTrailingNewline = lines.at(-1) === '';
  if (hasTrailingNewline) {
    lines.pop();
  }
  return { lines, endOfLine, hasTrailingNewline };
}

function joinLines(lines, endOfLine, hasTrailingNewline) {
  if (lines.length === 0) {
    return '';
  }
  return lines.join(endOfLine) + (hasTrailingNewline ? endOfLine : '');
}

function isMarkerStart(line) {
  return line.trimStart().startsWith(markerStart);
}

function isMarkerEnd(line) {
  return line.trimStart().startsWith(markerEnd);
}

function findTables(lines) {
  const tables = [];
  lines.forEach((line, index) => {
    const header = parseTableHeader(line);
    if (header !== null) {
      tables.push({ ...header, headerIndex: index });
    }
  });
  return tables.map((table, position) => ({
    ...table,
    endIndex: position + 1 < tables.length ? tables[position + 1].headerIndex : lines.length,
  }));
}

function findTableForLine(tables, lineIndex) {
  let found = null;
  for (const table of tables) {
    if (table.headerIndex < lineIndex && lineIndex < table.endIndex) {
      found = table;
    }
  }
  return found;
}

export function analyzeKeyBinding(lines, tables) {
  const occupiedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!keyBindingPattern.test(stripComment(lines[index]))) {
      continue;
    }
    const table = findTableForLine(tables, index);
    const isOwnBinding = table !== null
      && table.isArray
      && table.name === 'keys.command'
      && keyLinePattern.test(stripComment(lines[index]))
      && lines.slice(table.headerIndex + 1, table.endIndex).some((line) => openCommandLinePattern.test(stripComment(line)));
    if (isOwnBinding) {
      return { state: 'configured', lineNumber: index + 1 };
    }
    occupiedLines.push(index + 1);
  }
  if (occupiedLines.length > 0) {
    return { state: 'occupied', lineNumber: occupiedLines[0] };
  }
  return { state: 'missing' };
}

// 舊版的側邊欄 rows 一定含 $sub1（hook 寫的 pane token）；本 plugin 的 marker 區塊只有快捷鍵與 rows 兩種
function isRowsBlock(blockLines) {
  return blockLines.some((line) => stripComment(line).includes('$sub1'));
}

// 回傳 { blocks: [{ startIndex, endIndex, isRows }], unterminatedIndex }；endIndex 是結束 marker 那一行
function findMarkedBlocks(lines) {
  const blocks = [];
  let startIndex = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (startIndex === null) {
      if (isMarkerStart(lines[index])) {
        startIndex = index;
      }
    } else if (isMarkerEnd(lines[index])) {
      blocks.push({ startIndex, endIndex: index, isRows: isRowsBlock(lines.slice(startIndex, index + 1)) });
      startIndex = null;
    }
  }
  return { blocks, unterminatedIndex: startIndex };
}

function describeUnterminatedBlock(index) {
  return `line ${index + 1} starts a subagent.watch block that never ends ("${markerEnd}" is missing); nothing was changed`;
}

// 刪掉 shouldRemove 為真的 marker 區塊，回傳新的行與 remove operations（行號是原檔的）
function removeBlocks(lines, blocks, shouldRemove) {
  const operations = [];
  const removedIndexes = new Set();
  for (const block of blocks.filter(shouldRemove)) {
    operations.push({ kind: 'remove', startLineNumber: block.startIndex + 1, lines: lines.slice(block.startIndex, block.endIndex + 1) });
    for (let index = block.startIndex; index <= block.endIndex; index += 1) {
      removedIndexes.add(index);
    }
  }
  return { lines: lines.filter((line, index) => !removedIndexes.has(index)), operations };
}

// 手動加、沒有 marker 的設定不會被動；列出行號讓使用者自己決定
function findLeftoverLineNumbers(lines, pattern) {
  const lineNumbers = [];
  lines.forEach((line, index) => {
    if (pattern.test(stripComment(line))) {
      lineNumbers.push(index + 1);
    }
  });
  return lineNumbers;
}

export function analyzeHerdrConfig(text) {
  const { lines } = splitLines(text);
  return { key: analyzeKeyBinding(lines, findTables(lines)) };
}

// setup：補上 prefix+. 的快捷鍵，並拿掉舊版加的側邊欄 rows 區塊（側邊欄數量已經拿掉）
export function applyHerdrSetup(text) {
  const { lines, endOfLine, hasTrailingNewline } = splitLines(text);
  const { blocks, unterminatedIndex } = findMarkedBlocks(lines);
  if (unterminatedIndex !== null) {
    return { text, analysis: null, operations: [], error: describeUnterminatedBlock(unterminatedIndex), leftoverRowLineNumbers: [] };
  }
  const removal = removeBlocks(lines, blocks, (block) => block.isRows);
  const nextLines = removal.lines;
  const operations = [...removal.operations];
  const analysis = { key: analyzeKeyBinding(nextLines, findTables(nextLines)), removedRowsBlockCount: removal.operations.length };
  if (analysis.key.state === 'missing') {
    const blockLines = buildKeyBlockLines();
    operations.push({ kind: 'append', afterLineNumber: lines.length, lines: blockLines });
    nextLines.push(...blockLines);
  }
  // 原本沒有結尾換行時補上：附加的區塊一定要從新的一行開始
  const isAppending = analysis.key.state === 'missing';
  const nextText = operations.length === 0 ? text : joinLines(nextLines, endOfLine, isAppending || hasTrailingNewline);
  return { text: nextText, analysis, operations, error: null, leftoverRowLineNumbers: findLeftoverLineNumbers(nextLines, /\$sub1/) };
}

export function removeHerdrSetup(text) {
  const { lines, endOfLine, hasTrailingNewline } = splitLines(text);
  const { blocks, unterminatedIndex } = findMarkedBlocks(lines);
  if (unterminatedIndex !== null) {
    return { text, operations: [], error: describeUnterminatedBlock(unterminatedIndex), leftoverLineNumbers: [] };
  }
  const removal = removeBlocks(lines, blocks, () => true);
  const nextText = removal.operations.length === 0 ? text : joinLines(removal.lines, endOfLine, hasTrailingNewline);
  const leftoverPattern = new RegExp(`${openActionId.replaceAll('.', '\\.')}|\\$sub1`);
  return { text: nextText, operations: removal.operations, error: null, leftoverLineNumbers: findLeftoverLineNumbers(removal.lines, leftoverPattern) };
}
