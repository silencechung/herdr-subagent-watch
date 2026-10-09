// 自己解析 raw input 而不用 readline.emitKeypressEvents：readline 為了分辨單獨的 Esc 會等約 0.5 秒才回報
export const escapeTimeoutMs = 30;

function decodeCsi(parameters, finalCharacter) {
  if (finalCharacter === 'D') {
    return 'left';
  }
  if (finalCharacter === 'C') {
    return 'right';
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
        const match = /^\x1b\[([0-9;:?]*)([\x40-\x7e])/.exec(pending);
        if (match === null) {
          if (/^\x1b\[[0-9;:?]*$/.test(pending)) {
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
