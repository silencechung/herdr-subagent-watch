export const wheelScrollLines = 3;

// 每個 tab 一份；暫停時用 topIndex（從最舊那端算）固定位置，新行接在後面，畫面不會跟著往下跑
export function createScrollState() {
  return { isFollowing: true, topIndex: 0, lineCountAtPause: 0 };
}

function getMaximumTop(totalLines, viewHeight) {
  return Math.max(0, totalLines - viewHeight);
}

function follow(state) {
  state.isFollowing = true;
  state.topIndex = 0;
  state.lineCountAtPause = 0;
}

export function resolveScrollView(state, totalLines, viewHeight) {
  const maximumTop = getMaximumTop(totalLines, viewHeight);
  // 視窗變高或 log 重讀變短後，暫停的位置可能已經到底；不恢復 follow 的話 `↓ N new` 會指著畫面上已經看得到的行
  if (!state.isFollowing && state.topIndex >= maximumTop) {
    follow(state);
  }
  if (state.isFollowing) {
    return { start: maximumTop, isFollowing: true, newLineCount: 0 };
  }
  return {
    start: state.topIndex,
    isFollowing: false,
    newLineCount: Math.max(0, totalLines - state.lineCountAtPause),
  };
}

// 捲到最底就恢復 follow；內容不滿一頁時不會進入暫停
export function scrollToLine(state, topIndex, totalLines, viewHeight) {
  const maximumTop = getMaximumTop(totalLines, viewHeight);
  const nextTop = Math.min(Math.max(0, topIndex), maximumTop);
  if (nextTop >= maximumTop) {
    follow(state);
    return;
  }
  if (state.isFollowing) {
    state.lineCountAtPause = totalLines;
  }
  state.isFollowing = false;
  state.topIndex = nextTop;
}

export function scrollBy(state, lineCount, totalLines, viewHeight) {
  const { start } = resolveScrollView(state, totalLines, viewHeight);
  scrollToLine(state, start + lineCount, totalLines, viewHeight);
}

// 回傳 key 是不是捲動鍵
export function applyScrollKey(state, key, totalLines, viewHeight) {
  if (key === 'home') {
    scrollToLine(state, 0, totalLines, viewHeight);
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
  scrollBy(state, lineCountByKey[key], totalLines, viewHeight);
  return true;
}
