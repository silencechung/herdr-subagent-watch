export const wheelScrollLines = 3;

// 捲動單位是折行後的畫面行；rowCounts[i] 是第 i 個事件佔幾行（至少 1）
// rowStarts 多放一格總行數：rowStarts[eventCount] === totalRows，算「某事件之後有幾行」不用特判
export function createRowLayout(rowCounts) {
  const rowStarts = new Array(rowCounts.length + 1);
  rowStarts[0] = 0;
  for (let index = 0; index < rowCounts.length; index += 1) {
    rowStarts[index + 1] = rowStarts[index] + rowCounts[index];
  }
  return { eventCount: rowCounts.length, totalRows: rowStarts[rowCounts.length], rowStarts };
}

// 回傳第 row 行屬於哪個事件、是那個事件的第幾行；row 超出範圍時夾到最後一行
export function locateRow(layout, row) {
  if (layout.eventCount === 0) {
    return { eventIndex: 0, rowOffset: 0 };
  }
  const targetRow = Math.min(Math.max(0, row), layout.totalRows - 1);
  let low = 0;
  let high = layout.eventCount - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (layout.rowStarts[middle] <= targetRow) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { eventIndex: low, rowOffset: targetRow - layout.rowStarts[low] };
}

// 每個 tab 一份；暫停時記「哪個事件的第幾行在最上面」而不是絕對行號：resize 重新折行後還停在同一個事件
// eventCountAtPause：暫停當下有幾個事件，之後進來的事件佔的行數就是 `↓ N new`
export function createScrollState() {
  return { isFollowing: true, anchorEventIndex: 0, anchorRowOffset: 0, eventCountAtPause: 0 };
}

function getMaximumTop(layout, viewHeight) {
  return Math.max(0, layout.totalRows - viewHeight);
}

function follow(state) {
  state.isFollowing = true;
  state.anchorEventIndex = 0;
  state.anchorRowOffset = 0;
  state.eventCountAtPause = 0;
}

function getAnchorRow(state, layout) {
  if (state.anchorEventIndex >= layout.eventCount) {
    return layout.totalRows;
  }
  const eventRowCount = layout.rowStarts[state.anchorEventIndex + 1] - layout.rowStarts[state.anchorEventIndex];
  return layout.rowStarts[state.anchorEventIndex] + Math.min(state.anchorRowOffset, eventRowCount - 1);
}

export function resolveScrollView(state, layout, viewHeight) {
  const maximumTop = getMaximumTop(layout, viewHeight);
  // 視窗變高、變寬或 log 重讀變短後，暫停的位置可能已經到底；不恢復 follow 的話 `↓ N new` 會指著畫面上已經看得到的行
  if (!state.isFollowing && getAnchorRow(state, layout) >= maximumTop) {
    follow(state);
  }
  if (state.isFollowing) {
    return { start: maximumTop, isFollowing: true, newLineCount: 0 };
  }
  const pausedEventCount = Math.min(state.eventCountAtPause, layout.eventCount);
  return {
    start: getAnchorRow(state, layout),
    isFollowing: false,
    newLineCount: Math.max(0, layout.totalRows - layout.rowStarts[pausedEventCount]),
  };
}

// 捲到最底就恢復 follow；內容不滿一頁時不會進入暫停
export function scrollToLine(state, row, layout, viewHeight) {
  const maximumTop = getMaximumTop(layout, viewHeight);
  const nextTop = Math.min(Math.max(0, row), maximumTop);
  if (nextTop >= maximumTop) {
    follow(state);
    return;
  }
  if (state.isFollowing) {
    state.eventCountAtPause = layout.eventCount;
  }
  const { eventIndex, rowOffset } = locateRow(layout, nextTop);
  state.isFollowing = false;
  state.anchorEventIndex = eventIndex;
  state.anchorRowOffset = rowOffset;
}

export function scrollBy(state, lineCount, layout, viewHeight) {
  const { start } = resolveScrollView(state, layout, viewHeight);
  scrollToLine(state, start + lineCount, layout, viewHeight);
}

// 回傳 key 是不是捲動鍵
export function applyScrollKey(state, key, layout, viewHeight) {
  if (key === 'home') {
    scrollToLine(state, 0, layout, viewHeight);
    return true;
  }
  if (key === 'end') {
    follow(state);
    return true;
  }
  const lineCountByKey = {
    up: -1,
    down: 1,
    'page-up': -viewHeight,
    'page-down': viewHeight,
    'wheel-up': -wheelScrollLines,
    'wheel-down': wheelScrollLines,
  };
  if (!Object.hasOwn(lineCountByKey, key)) {
    return false;
  }
  scrollBy(state, lineCountByKey[key], layout, viewHeight);
  return true;
}
