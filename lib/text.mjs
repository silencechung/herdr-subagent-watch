const ansiEscapePattern = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/g;

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

export function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    width += characterWidth(character);
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

export function truncateToWidth(text, maximumWidth) {
  let output = '';
  let width = 0;
  for (const character of text) {
    const nextWidth = characterWidth(character);
    if (width + nextWidth > maximumWidth) {
      break;
    }
    output += character;
    width += nextWidth;
  }
  return { text: output, width };
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
