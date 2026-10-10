// 沒有 TOML parser（不裝套件），只做保守的逐行文字處理：看不懂就跳過、請使用者手動貼，寫完再交給 `herdr config check` 把關。
// 已知不處理：多行字串（""" / '''）裡出現像 table header 或 key 的內容會被誤判，最壞結果是跳過或被 config check 擋下還原。

export const markerStart = '# >>> subagent.watch';
export const markerEnd = '# <<< subagent.watch';
export const keyBinding = 'prefix+.';
export const openActionId = 'subagent.watch.open';
export const rowsTableName = 'ui.sidebar.agents.rows_by_agent';
export const sidebarTokenCount = 5;

const markerStartLine = `${markerStart} (added by subagent.watch.setup; subagent.watch.remove deletes this block)`;
const tableHeaderPattern = /^\s*(\[\[?)\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*(\]\]?)\s*$/;
const claudeKeyPattern = /^\s*(?:claude|"claude"|'claude')\s*=/;
const rowsKeyPattern = /^\s*rows\s*=/;
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

export function buildSubTokenRowLines() {
  const lines = [];
  for (let index = 1; index <= sidebarTokenCount; index += 1) {
    lines.push(`  [{ token = "$sub${index}", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],`);
  }
  return lines;
}

// 前兩行是 herdr 預設的 agent rows：rows_by_agent 會整個取代 rows，不寫的話 claude 那一列會只剩 sub agent 行
export function buildClaudeRowsLines() {
  return [
    'claude = [',
    '  ["state_icon", "machine", "workspace", "tab"],',
    '  ["agent"],',
    ...buildSubTokenRowLines(),
    ']',
  ];
}

export function buildRowsBlockLines({ includeHeader }) {
  return [
    markerStartLine,
    ...(includeHeader ? [`[${rowsTableName}]`] : []),
    ...buildClaudeRowsLines(),
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

export function buildManualRowsSnippet() {
  return [
    `# add these rows to the end of your own \`claude = [...]\` under [${rowsTableName}]`,
    ...buildSubTokenRowLines(),
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

// 從 `key = [` 開始數括號（略過字串與註解），回傳整個 array 值的原文；括號不平衡就回傳到檔尾
export function readArrayValue(lines, startIndex) {
  const text = lines.slice(startIndex).join('\n');
  const valueStart = text.indexOf('=') + 1;
  let depth = 0;
  let quote = null;
  let isComment = false;
  for (let index = valueStart; index < text.length; index += 1) {
    const character = text[index];
    if (isComment) {
      if (character === '\n') {
        isComment = false;
      }
      continue;
    }
    if (quote !== null) {
      if (quote === '"' && character === '\\') {
        index += 1;
      } else if (character === quote || character === '\n') {
        quote = null;
      }
      continue;
    }
    if (character === '#') {
      isComment = true;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(valueStart, index + 1);
      }
    }
  }
  return text.slice(valueStart);
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

export function analyzeSidebarRows(lines, tables) {
  const rowsTables = tables.filter((table) => table.name === rowsTableName && !table.isArray);
  if (rowsTables.length === 0) {
    const otherMention = lines.findIndex((line) => stripComment(line).includes('rows_by_agent'));
    if (otherMention !== -1) {
      return { state: 'custom', lineNumber: otherMention + 1, reason: 'rows_by_agent is set in a form this setup does not edit' };
    }
    return { state: 'missing-table' };
  }
  const table = rowsTables[0];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    if (!claudeKeyPattern.test(stripComment(lines[index]))) {
      continue;
    }
    if (readArrayValue(lines, index).includes('$sub1')) {
      return { state: 'configured', lineNumber: index + 1 };
    }
    return { state: 'custom', lineNumber: index + 1, reason: 'you already have your own claude rows' };
  }
  return { state: 'missing-claude', headerIndex: table.headerIndex };
}

// rows_by_agent.claude 會取代使用者自訂的 [ui.sidebar.agents] rows（claude 那一列改回 herdr 預設兩行），只提醒、不擋
function findCustomAgentRows(lines, tables) {
  const agentsTable = tables.find((table) => table.name === 'ui.sidebar.agents' && !table.isArray);
  if (agentsTable === undefined) {
    return null;
  }
  for (let index = agentsTable.headerIndex + 1; index < agentsTable.endIndex; index += 1) {
    if (rowsKeyPattern.test(stripComment(lines[index]))) {
      return index + 1;
    }
  }
  return null;
}

export function analyzeHerdrConfig(text) {
  const { lines } = splitLines(text);
  const tables = findTables(lines);
  return {
    key: analyzeKeyBinding(lines, tables),
    rows: analyzeSidebarRows(lines, tables),
    customAgentRowsLineNumber: findCustomAgentRows(lines, tables),
  };
}

export function applyHerdrSetup(text) {
  const analysis = analyzeHerdrConfig(text);
  const { lines, endOfLine } = splitLines(text);
  const nextLines = [...lines];
  const operations = [];
  if (analysis.rows.state === 'missing-claude') {
    const blockLines = buildRowsBlockLines({ includeHeader: false });
    nextLines.splice(analysis.rows.headerIndex + 1, 0, ...blockLines);
    operations.push({ kind: 'insert', afterLineNumber: analysis.rows.headerIndex + 1, lines: blockLines });
  }
  if (analysis.key.state === 'missing') {
    const blockLines = buildKeyBlockLines();
    operations.push({ kind: 'append', afterLineNumber: nextLines.length, lines: blockLines });
    nextLines.push(...blockLines);
  }
  if (analysis.rows.state === 'missing-table') {
    const blockLines = buildRowsBlockLines({ includeHeader: true });
    operations.push({ kind: 'append', afterLineNumber: nextLines.length, lines: blockLines });
    nextLines.push(...blockLines);
  }
  // 原本沒有結尾換行時補上：附加的區塊一定要從新的一行開始
  const nextText = operations.length === 0 ? text : joinLines(nextLines, endOfLine, true);
  return { text: nextText, analysis, operations };
}

export function removeHerdrSetup(text) {
  const { lines, endOfLine, hasTrailingNewline } = splitLines(text);
  const nextLines = [];
  const operations = [];
  let blockStartIndex = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (blockStartIndex === null) {
      if (isMarkerStart(line)) {
        blockStartIndex = index;
      } else {
        nextLines.push(line);
      }
    } else if (isMarkerEnd(line)) {
      operations.push({ kind: 'remove', startLineNumber: blockStartIndex + 1, lines: lines.slice(blockStartIndex, index + 1) });
      blockStartIndex = null;
    }
  }
  if (blockStartIndex !== null) {
    return {
      text,
      operations: [],
      error: `line ${blockStartIndex + 1} starts a subagent.watch block that never ends ("${markerEnd}" is missing); nothing was removed`,
      leftoverLineNumbers: [],
    };
  }
  const nextText = operations.length === 0 ? text : joinLines(nextLines, endOfLine, hasTrailingNewline);
  // 手動加、沒有 marker 的設定不會被刪；列出行號讓使用者自己決定
  const leftoverLineNumbers = [];
  splitLines(nextText).lines.forEach((line, index) => {
    const content = stripComment(line);
    if (content.includes(openActionId) || content.includes('$sub1')) {
      leftoverLineNumbers.push(index + 1);
    }
  });
  return { text: nextText, operations, error: null, leftoverLineNumbers };
}
