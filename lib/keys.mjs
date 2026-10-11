// 自己解析 raw input 而不用 readline.emitKeypressEvents：readline 為了分辨單獨的 Esc 會等約 0.5 秒才回報
export const escapeTimeoutMs = 30;
// 輸入的編號可能還有下一位（例：14 個 tab 時按 1）時等多久；夠打第二個數字，又不會覺得按了沒反應
export const tabNumberTimeoutMs = 600;

const keyByFinalCharacter = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

// `CSI <n> ~`：Home／End 各 terminal 送的編號不同（1/7、4/8），都收
const keyByTildeCode = {
  1: 'home',
  7: 'home',
  4: 'end',
  8: 'end',
  5: 'page-up',
  6: 'page-down',
};

function decodeMouseButton(button) {
  // Shift／Alt／Ctrl 會在 button 上加 4／8／16，滾輪方向只看剩下的值
  const baseButton = button & ~(4 | 8 | 16);
  if (baseButton === 64) {
    return 'wheel-up';
  }
  if (baseButton === 65) {
    return 'wheel-down';
  }
  return 'other';
}

// SGR mouse（1006）：`CSI < button ; x ; y M`，放開是小寫 m；x、y 是 1-based，左上角 (1, 1)
// 左鍵按下（button 0，修飾鍵位元和滾輪一樣不看）回傳 click 與座標；放開一律是 other，否則一次點擊會切兩次
function decodeSgrMouse(parameters, finalCharacter) {
  if (finalCharacter !== 'M') {
    return { key: 'other', detail: undefined };
  }
  const [buttonText, xText, yText] = parameters.slice(1).split(';');
  const button = Number(buttonText);
  if ((button & ~(4 | 8 | 16)) === 0) {
    const x = Number(xText);
    const y = Number(yText);
    if (Number.isInteger(x) && Number.isInteger(y) && x > 0 && y > 0) {
      return { key: 'click', detail: { x, y } };
    }
    return { key: 'other', detail: undefined };
  }
  return { key: decodeMouseButton(button), detail: undefined };
}

export function isDigitKey(key) {
  return typeof key === 'string' && key.length === 1 && key >= '0' && key <= '9';
}

function decodeCsi(parameters, finalCharacter) {
  if (Object.hasOwn(keyByFinalCharacter, finalCharacter)) {
    return keyByFinalCharacter[finalCharacter];
  }
  if (finalCharacter === '~') {
    const code = parameters.split(';')[0];
    return Object.hasOwn(keyByTildeCode, code) ? keyByTildeCode[code] : 'other';
  }
  if (finalCharacter === 'u') {
    // kitty keyboard protocol：terminal 有開這個模式時 Esc、q、Ctrl+C 會變成 CSI u
    const [codeText, modifierText] = parameters.split(';');
    const code = Number(codeText);
    const modifier = Number(modifierText ?? '1');
    if (code === 27) {
      return 'escape';
    }
    if (code === 113 && modifier === 1) {
      return 'q';
    }
    if (code === 99 && modifier === 5) {
      return 'ctrl-c';
    }
  }
  return 'other';
}

export function createKeyDecoder(onKey, { timeoutMs = escapeTimeoutMs, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = '';
  let escapeTimer = null;

  // click 的第二個參數是 { x, y }；其他 key 只有名稱
  function emit(key, detail) {
    if (detail === undefined) {
      onKey(key);
    } else {
      onKey(key, detail);
    }
  }

  function flushLoneEscape() {
    escapeTimer = null;
    if (pending === '\x1b') {
      pending = '';
      emit('escape');
    }
  }

  function drainPending() {
    while (pending.length > 0) {
      const first = pending[0];
      if (first !== '\x1b') {
        pending = pending.slice(1);
        if (first === '\x03') {
          emit('ctrl-c');
        } else if (first === 'q' || first === 'Q') {
          emit('q');
        } else if (isDigitKey(first)) {
          emit(first);
        } else {
          emit('other');
        }
        continue;
      }
      if (pending.length === 1) {
        // Esc 與方向鍵的後半段可能分兩次送達，等一下下再判斷是不是單獨的 Esc
        escapeTimer = setTimer(flushLoneEscape, timeoutMs);
        return;
      }
      const second = pending[1];
      if (second === '[') {
        // parameter byte 要收整個 0x30–0x3F：SGR mouse 的 `<` 也在這段，漏掉的話整串會被拆成一個個字元
        const match = /^\x1b\[([\x30-\x3f]*)([\x40-\x7e])/.exec(pending);
        if (match === null) {
          if (/^\x1b\[[\x30-\x3f]*$/.test(pending)) {
            escapeTimer = setTimer(() => {
              escapeTimer = null;
              pending = '';
              emit('other');
            }, timeoutMs);
            return;
          }
          pending = pending.slice(2);
          emit('other');
          continue;
        }
        if (match[0] === '\x1b[M') {
          // 不支援 SGR 的 terminal 會退回 X10 格式：`CSI M` 後面接 3 個 raw byte（button、x、y 各加 32）；
          // 不一起吃掉的話，座標 byte 剛好是 q 就會關掉 viewer
          if (pending.length < 6) {
            escapeTimer = setTimer(() => {
              escapeTimer = null;
              pending = '';
              emit('other');
            }, timeoutMs);
            return;
          }
          const button = pending.charCodeAt(3) - 32;
          pending = pending.slice(6);
          emit(decodeMouseButton(button));
          continue;
        }
        pending = pending.slice(match[0].length);
        if (match[1].startsWith('<')) {
          const { key, detail } = decodeSgrMouse(match[1], match[2]);
          emit(key, detail);
          continue;
        }
        emit(decodeCsi(match[1], match[2]));
        continue;
      }
      if (second === 'O') {
        if (pending.length < 3) {
          escapeTimer = setTimer(() => {
            escapeTimer = null;
            pending = '';
            emit('other');
          }, timeoutMs);
          return;
        }
        const finalCharacter = pending[2];
        pending = pending.slice(3);
        emit(decodeCsi('', finalCharacter));
        continue;
      }
      if (second === '\x1b') {
        pending = pending.slice(1);
        emit('escape');
        continue;
      }
      // Esc 後面接一般字元是 Alt+字元，不當成 Esc 關閉
      pending = pending.slice(2);
      emit('other');
    }
  }

  return {
    feed(chunk) {
      if (escapeTimer !== null) {
        clearTimer(escapeTimer);
        escapeTimer = null;
      }
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      drainPending();
    },
    dispose() {
      if (escapeTimer !== null) {
        clearTimer(escapeTimer);
        escapeTimer = null;
      }
    },
  };
}

// 數字鍵跳 tab：輸入的編號還可能是更長編號的開頭時（例：14 個 tab 時按 1，可能是 10–14）等 timeoutMs 看有沒有下一位，
// 沒有就跳到目前輸入的編號；不可能再延伸時（按 2–9 而沒有 20 以上的 tab）立刻跳
// 等待用計時器而不是擋住輸入迴圈：等的期間畫面照常更新；onJump 收到的是 1-based 編號
export function createTabNumberInput(onJump, { timeoutMs = tabNumberTimeoutMs, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let typed = '';
  let timer = null;

  function cancel() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    typed = '';
  }

  function jump(number) {
    cancel();
    onJump(number);
  }

  return {
    // 0 開頭或超出 tabCount 的輸入不跳、直接清掉，下一個數字重新開始
    press(digit, tabCount) {
      const nextTyped = typed + digit;
      cancel();
      const number = Number(nextTyped);
      if (nextTyped.startsWith('0') || number > tabCount) {
        return;
      }
      if (number * 10 > tabCount) {
        jump(number);
        return;
      }
      typed = nextTyped;
      timer = setTimer(() => {
        timer = null;
        jump(number);
      }, timeoutMs);
    },
    // 輸入中按了別的鍵：丟掉輸入到一半的編號
    cancel,
    dispose: cancel,
  };
}
