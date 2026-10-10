// 自己解析 raw input 而不用 readline.emitKeypressEvents：readline 為了分辨單獨的 Esc 會等約 0.5 秒才回報
export const escapeTimeoutMs = 30;

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

function decodeCsi(parameters, finalCharacter) {
  if (parameters.startsWith('<')) {
    // SGR mouse（1006）：`CSI < button ; x ; y M`，放開是小寫 m
    if (finalCharacter !== 'M') {
      return 'other';
    }
    return decodeMouseButton(Number(parameters.slice(1).split(';')[0]));
  }
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

  function emit(key) {
    onKey(key);
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
