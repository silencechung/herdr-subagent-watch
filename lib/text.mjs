// 會改變 terminal 狀態的序列，7-bit（ESC 開頭）與 8-bit（C1 code point）兩種寫法都收：
// - CSI：ESC [ 或 U+009B，接參數、中間、結尾 byte
// - OSC／DCS／SOS／PM／APC：字串型，到 BEL 或 ST（ESC \ 或 U+009C）才結束，有結尾就整段剝掉
//   沒有結尾時只剝 introducer、後面的文字留著：cp1252 亂碼常帶單獨的 U+009D（例 "â€\x9d"），吃到字串尾會讓後面整段（多行摘要是後面每一行）消失
//   內容不能含 ESC 或其他 introducer：否則沒有結尾時每個 introducer 都掃到字串尾再退回，對抗輸入會變成平方時間
// - 其他 ESC 序列：ESC 接中間 byte 與結尾 byte（例 ESC ( B、ESC 7）
const escapeSequencePattern = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])(?:[^\x07\x1b\x90\x98\x9c-\x9f]*(?:\x07|\x1b\\|\x9c))?|\x1b[ -/]*[0-~]/g;
// 剝完序列後剩下的單一 C0、DEL、C1
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const controlCharacterExceptNewlinePattern = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
// \p{Cf}：bidi override（例 U+202E）會讓畫面上的字序和實際內容不同，零寬字元會讓寬度算錯
// ZWNJ（U+200C）、ZWJ（U+200D）例外：拿掉會把 emoji ZWJ 序列拆成好幾個 emoji、改變波斯文等文字的字形，它們本身寬度是 0
const formatCharacterPattern = /(?![\u200c\u200d])\p{Cf}/gu;
const anyControlPattern = /[\u0000-\u001f\u007f-\u009f]|(?![\u200c\u200d])\p{Cf}/u;
const tabReplacement = '    ';

const zeroWidthRanges = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  // 這段的 Cf 只有 ZWNJ、ZWJ 會留到量寬度的時候（其他在 stripTerminalControls 剝掉）
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];

// Unicode 16.0 East_Asian_Width 為 W 或 F 的全部碼位（Perl Unicode::UCD 產生，已用 Python unicodedata 逐一比對）
// 描述與參數常有中文、emoji，寬度算成 1 會讓整行超出 terminal 寬度而換行
// 不要把 EAW 為 A／N 的符號（● ✓ ◀ ▶ │ ·）加進來：ambiguous 寬度由 terminal 設定決定，介面字元都假設它是 1
// 這張表和 zeroWidthRanges 都必須照起點排序且不重疊：isInRanges 用二分搜尋
export const wideRanges = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x268a, 0x268f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e5],
  [0x31ef, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18cff, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1d300, 0x1d356],
  [0x1d360, 0x1d376],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa89],
  [0x1fa8f, 0x1fac6],
  [0x1face, 0x1fadc],
  [0x1fadf, 0x1fae9],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isInRanges(codePoint, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint > end) {
      low = middle + 1;
    } else {
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

// 量寬度、截斷、折行的最底層都先過這裡：外來的 ESC 序列與控制字元整段丟掉，不當成 0 寬保留下來輸出
// SGR 只能由 render.mjs 的 composeLine 在截斷之後加上
export function stripTerminalControls(text) {
  if (!anyControlPattern.test(text)) {
    return text;
  }
  return text
    .replace(escapeSequencePattern, '')
    .replace(formatCharacterPattern, '')
    .replace(controlCharacterPattern, '');
}

export function displayWidth(text) {
  let width = 0;
  for (const character of stripTerminalControls(text)) {
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
    .replace(escapeSequencePattern, ' ')
    .replace(formatCharacterPattern, '')
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
    .replace(escapeSequencePattern, '')
    .replace(formatCharacterPattern, '')
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
  for (const character of stripTerminalControls(text)) {
    const nextWidth = characterWidth(character);
    if (width + nextWidth > maximumWidth) {
      break;
    }
    output += character;
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
  for (const character of stripTerminalControls(text)) {
    const characterColumns = characterWidth(character);
    // currentWidth > 0：寬度小於 2 時寬字放不進空行，硬放進去才不會無限換行
    if (characterColumns > 0 && currentWidth > 0 && currentWidth + characterColumns > maximumWidth) {
      if (rows.length < maximumRows) {
        rows.push(currentRow);
      }
      rowCount += 1;
      currentRow = '';
      currentWidth = 0;
    }
    if (rows.length < maximumRows) {
      currentRow += character;
    }
    currentWidth += characterColumns;
  }
  if (rows.length < maximumRows) {
    rows.push(currentRow);
  }
  rowCount += 1;
  return { rows, rowCount };
}

export function truncateWithEllipsis(text, maximumWidth) {
  const printableText = stripTerminalControls(text);
  if (displayWidth(printableText) <= maximumWidth) {
    return printableText;
  }
  if (maximumWidth <= 1) {
    return truncateToWidth(printableText, maximumWidth).text;
  }
  return `${truncateToWidth(printableText, maximumWidth - 1).text}…`;
}

export function padEndToWidth(text, targetWidth) {
  const printableText = stripTerminalControls(text);
  const width = displayWidth(printableText);
  if (width >= targetWidth) {
    return printableText;
  }
  return printableText + ' '.repeat(targetWidth - width);
}
