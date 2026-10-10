#!/bin/sh
# subagent.watch 的 node launcher：herdr manifest 與 Claude Code hook 都經過這裡，不寫死 node 路徑。
# 用法：sh bin/run.sh <script.mjs> [args...]；相對路徑的 script 以 plugin 根目錄為準，不管目前在哪個資料夾。
set -u

# PATH 的空項目與相對項目（`node_modules/.bin`、`.`）是相對於 cwd，也就是使用者開著的 repo：照原樣用的話，
# 下面的 dirname、sed、sort、tail、cut 和 exec 出去的 node 都可能跑到 repo 裡的同名檔案。一開頭只留絕對路徑的項目再 export。
# 只用 shell 內建的字串處理，這時候還不能呼叫任何外部指令
clean_path=''
remaining_path=${PATH:-}
while [ -n "$remaining_path" ]; do
  directory=${remaining_path%%:*}
  case $remaining_path in
    *:*) remaining_path=${remaining_path#*:} ;;
    *) remaining_path='' ;;
  esac
  case $directory in
    /*) clean_path=${clean_path:+$clean_path:}$directory ;;
  esac
done
# 一個都不剩時不能留空字串：bash（Fedora 系的 sh）把空的 PATH 當成 cwd 去找指令
PATH=${clean_path:-/usr/bin:/bin}
export PATH

minimum_node_major=22
newline='
'

plugin_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 1

if [ "$#" -lt 1 ]; then
  echo 'usage: sh bin/run.sh <script.mjs> [args...]' >&2
  exit 2
fi
script=$1
shift
case $script in
  /*) ;;
  *) script=$plugin_root/$script ;;
esac

# sidebar hook 套用到使用者所有 Claude session：找不到 node 也要安靜地 exit 0，不能讓每次開 sub agent 都跳 hook error
is_quiet=0
case $script in
  */hooks/sidebar-hook.mjs) is_quiet=1 ;;
esac

node=''
tried=''
rejected=''

try_node() {
  candidate=$1
  [ -n "$candidate" ] || return 1
  case "$newline$tried$newline" in
    *"$newline$candidate$newline"*) return 1 ;;
  esac
  tried=$tried$newline$candidate
  # PATH 上的 node 可能是 fnm multishell 的暫存路徑，開它的 shell 關掉後檔案就不在了
  if [ ! -f "$candidate" ] || [ ! -x "$candidate" ]; then
    return 1
  fi
  # --version 不啟動 V8，幾 ms 就回來；stdin 一定要切斷，hook 的 payload 要留給真正的 script 讀
  version=$("$candidate" --version 2>/dev/null </dev/null) || version=''
  major=${version#v}
  major=${major%%.*}
  case $major in
    '' | *[!0-9]*)
      rejected="$rejected$newline  $candidate (cannot read version)"
      return 1
      ;;
  esac
  if [ "$major" -lt "$minimum_node_major" ]; then
    rejected="$rejected$newline  $candidate ($version)"
    return 1
  fi
  node=$candidate
  return 0
}

newest_nvm_node() {
  nvm_versions=${NVM_DIR:-${HOME:-}/.nvm}/versions/node
  [ -d "$nvm_versions" ] || return 0
  newest=$(
    for directory in "$nvm_versions"/v*; do
      [ -d "$directory" ] && printf '%s\n' "${directory##*/}"
    done | sed -n 's/^v\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)$/\1 \2 \3 &/p' |
      sort -k1,1n -k2,2n -k3,3n | tail -n 1 | cut -d' ' -f4
  )
  [ -n "$newest" ] && printf '%s\n' "$nvm_versions/$newest/bin/node"
  return 0
}

wait_for_key() {
  printf '\nPress any key to close.' >&2
  saved_terminal=$(stty -g 2>/dev/null) || saved_terminal=''
  if [ -n "$saved_terminal" ]; then
    stty -icanon -echo min 1 time 0 2>/dev/null
    dd bs=1 count=1 >/dev/null 2>&1
    stty "$saved_terminal" 2>/dev/null
  else
    read -r _ || true
  fi
}

# 跟 lib/herdr.mjs 同規則：PATH 只看絕對路徑的項目（開頭已經清過 PATH，這裡照樣檢查，不靠前面的步驟）
find_herdr() {
  if [ -n "${HERDR_BIN_PATH:-}" ]; then
    printf '%s\n' "$HERDR_BIN_PATH"
    return 0
  fi
  remaining_path=${PATH:-}
  while [ -n "$remaining_path" ]; do
    directory=${remaining_path%%:*}
    case $remaining_path in
      *:*) remaining_path=${remaining_path#*:} ;;
      *) remaining_path='' ;;
    esac
    case $directory in
      /*)
        if [ -f "$directory/herdr" ] && [ -x "$directory/herdr" ]; then
          printf '%s\n' "$directory/herdr"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

fail() {
  if [ "$is_quiet" = 1 ]; then
    exit 0
  fi
  printf '%s\n' "$1" >&2
  if [ -n "${HERDR_PLUGIN_ACTION_ID:-}" ] && herdr_path=$(find_herdr); then
    # action 的輸出只進 plugin log，使用者看不到；用 herdr 通知告訴他為什麼沒反應
    "$herdr_path" notification show 'subagent.watch: Node.js 22+ not found' \
      --body 'Install Node.js 22+ or set SUBAGENT_WATCH_NODE, then try again.' >/dev/null 2>&1 || true
  fi
  # popup 裡的 command 一結束 popup 就關，不等按鍵的話錯誤訊息一閃就不見
  if [ -n "${HERDR_PLUGIN_ENTRYPOINT_ID:-}" ] && [ -t 0 ]; then
    wait_for_key
  fi
  exit 127
}

if [ -n "${SUBAGENT_WATCH_NODE:-}" ]; then
  if ! try_node "$SUBAGENT_WATCH_NODE"; then
    fail "subagent.watch: SUBAGENT_WATCH_NODE=$SUBAGENT_WATCH_NODE is not an executable Node.js $minimum_node_major or newer.$rejected"
  fi
else
  path_node=$(command -v node 2>/dev/null) || path_node=''
  case $path_node in
    /*) try_node "$path_node" ;;
  esac
  home=${HOME:-}
  if [ -z "$node" ] && [ -n "${FNM_DIR:-}" ]; then
    try_node "$FNM_DIR/aliases/default/bin/node"
  fi
  if [ -z "$node" ] && [ -n "$home" ]; then
    try_node "${XDG_DATA_HOME:-$home/.local/share}/fnm/aliases/default/bin/node" ||
      try_node "$home/.local/share/fnm/aliases/default/bin/node" ||
      try_node "$home/.fnm/aliases/default/bin/node" ||
      try_node "$home/.volta/bin/node" ||
      try_node "$(newest_nvm_node)"
  fi
  if [ -z "$node" ]; then
    try_node /opt/homebrew/bin/node || try_node /usr/local/bin/node || try_node /usr/bin/node
  fi
fi

if [ -z "$node" ]; then
  message="subagent.watch: Node.js $minimum_node_major or newer was not found.
Install Node.js $minimum_node_major+ (https://nodejs.org), or set SUBAGENT_WATCH_NODE to the absolute path of a node binary.
Looked at: node on PATH, fnm / Volta / nvm default installs, /opt/homebrew/bin, /usr/local/bin, /usr/bin."
  if [ -n "$rejected" ]; then
    message="$message${newline}Too old or unusable:$rejected"
  fi
  fail "$message"
fi

exec "$node" "$script" "$@"
