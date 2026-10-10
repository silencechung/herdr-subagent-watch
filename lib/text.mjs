const ansiEscapePattern = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const controlCharacterExceptNewlinePattern = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
// 一個 ANSI escape 整段當成一個寬度 0 的單位，其餘一個 code point 一個單位
const displayUnitPattern = new RegExp(`${ansiEscapePattern.source}|[\\s\\S]`, 'gu');
const tabReplacement = '    ';

const zeroWidthRanges = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];

// East Asian Wide / Fullwidth 主要區段；描述與參數常有中文，用 code point 數寬度會讓整行超出 terminal 寬度而換行
const wideRanges = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isInRanges(codePoint, ranges) {
  for (const [start, end] of ranges) {
    if (codePoint < start) {
      return false;
    }
    if (codePoint <= end) {
      return true;
    }
  }
  return false;
}

export function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (isInRanges(codePoint, zeroWidthRanges)) {
    return 0;
  }
  if (isInRanges(codePoint, wideRanges)) {
    return 2;
  }
  return 1;
}

// 沒有 ESC 時直接逐字走字串，不必先切成陣列
function getDisplayUnits(text) {
  if (!text.includes('\x1b')) {
    return text;
  }
  return text.match(displayUnitPattern) ?? [];
}

function getUnitWidth(unit) {
  return unit.startsWith('\x1b') ? 0 : characterWidth(unit);
}

export function displayWidth(text) {
  let width = 0;
  for (const unit of getDisplayUnits(text)) {
    width += getUnitWidth(unit);
  }
  return width;
}

// transcript 內容可能含換行、tab、ANSI escape，直接畫上去會打亂整個畫面
export function sanitizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(ansiEscapePattern, ' ')
    .replace(controlCharacterPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 保留換行，給要折行顯示的摘要用；其他控制字元與 ANSI escape 照樣拿掉，tab 換成固定空白才算得出寬度
export function sanitizeMultilineText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const lines = value
    .replace(ansiEscapePattern, '')
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', tabReplacement)
    .replace(controlCharacterExceptNewlinePattern, ' ')
    .split('\n')
    .map((line) => line.trimEnd());
  const firstIndex = lines.findIndex((line) => line !== '');
  if (firstIndex === -1) {
    return '';
  }
  const lastIndex = lines.findLastIndex((line) => line !== '');
  return lines.slice(firstIndex, lastIndex + 1).join('\n');
}

export function truncateToWidth(text, maximumWidth) {
  let output = '';
  let width = 0;
  for (const unit of getDisplayUnits(text)) {
    const nextWidth = getUnitWidth(unit);
    if (width + nextWidth > maximumWidth) {
      break;
    }
    output += unit;
    width += nextWidth;
  }
  return { text: output, width };
}

// 單一邏輯行（不含 \n）照顯示寬度硬折；寬字放不下就整個移到下一行，不切半
// rows 最多收 maximumRows 行（只要行數時傳 0，不組字串），rowCount 一定是完整行數
export function wrapToWidth(text, maximumWidth, maximumRows = Number.POSITIVE_INFINITY) {
  const rows = [];
  let rowCount = 0;
  let currentRow = '';
  let currentWidth = 0;
  for (const unit of getDisplayUnits(text)) {
    const unitWidth = getUnitWidth(unit);
    // currentWidth > 0：寬度小於 2 時寬字放不進空行，硬放進去才不會無限換行
    if (unitWidth > 0 && currentWidth > 0 && currentWidth + unitWidth > maximumWidth) {
      if (rows.length < maximumRows) {
        rows.push(currentRow);
      }
      rowCount += 1;
      currentRow = '';
      currentWidth = 0;
    }
    if (rows.length < maximumRows) {
      currentRow += unit;
    }
    currentWidth += unitWidth;
  }
  if (rows.length < maximumRows) {
    rows.push(currentRow);
  }
  rowCount += 1;
  return { rows, rowCount };
}

export function truncateWithEllipsis(text, maximumWidth) {
  if (displayWidth(text) <= maximumWidth) {
    return text;
  }
  if (maximumWidth <= 1) {
    return truncateToWidth(text, maximumWidth).text;
  }
  return `${truncateToWidth(text, maximumWidth - 1).text}…`;
}

export function padEndToWidth(text, targetWidth) {
  const width = displayWidth(text);
  if (width >= targetWidth) {
    return text;
  }
  return text + ' '.repeat(targetWidth - width);
}
