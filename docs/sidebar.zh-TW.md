# 側邊欄 sub agent 樹狀行

[English](sidebar.md) | 繁體中文

herdr 側邊欄 claude 那一列底下，用最多 5 行顯示這個 session **還在跑**的 sub agent：

```
<state_icon> <workspace> · <tab>
claude
├─ Explore ●
├─ general-purpose ●
└─ Plan ●
```

- 只列跑中的（`●`），不帶編號。sub 一結束（`SubagentStop`）那一行就拿掉，其餘的重排，`├─`／`└─` 每次都重算。
- 沒有任何跑中的 sub 時，側邊欄只剩 claude 那一列。
- 側邊欄不留歷程：結束的 sub 和它做過什麼，用 popup viewer（`prefix+.`）看，見 [README](../README.zh-TW.md)。

## 原理

1. Claude Code 啟動／結束 sub agent 時觸發 `SubagentStart`／`SubagentStop` hook，經 `bin/run.sh` 找到 node 後執行 `hooks/sidebar-hook.mjs`，payload 從 stdin 進來。
2. hook 更新狀態檔，再呼叫 `herdr pane report-metadata` 把樹狀行寫進 pane token `sub1`…`sub5`。
3. `config.toml` 的 `rows_by_agent.claude` 多了 `$sub1`…`$sub5` 五行；herdr 文件寫明沒回報的 token 會讓那一行整行消失，所以平常看不到空行。

### hook 輸入（2026-10-10 用 `claude -p` 2.1.296 實測）

| 欄位 | SubagentStart | SubagentStop |
| --- | --- | --- |
| `hook_event_name` | ✓ | ✓ |
| `session_id`、`transcript_path`、`cwd`、`prompt_id` | ✓ | ✓ |
| `agent_id`（例：`a12e8c491ce2f7f4a`，沒有 `agent-` 前綴） | ✓ | ✓ |
| `agent_type`（例：`general-purpose`） | ✓ | ✓ |
| `permission_mode`、`effort`、`stop_hook_active`、`agent_transcript_path`、`background_tasks`、`session_crons` | | ✓ |

官方文件說 `SubagentStop` 有 `last_assistant_message`，實測那次沒有；這個 hook 用不到它。

hook process 繼承 Claude Code 的環境變數：實測 `HERDR_PANE_ID`（例 `w8:pV`）、`HERDR_BIN_PATH`、`XDG_RUNTIME_DIR` 都在。範例 payload 在 `test/fixtures/sidebar/`。

### 寫出的檔案（`$XDG_RUNTIME_DIR/subagent-watch/`，tmpfs，重開機就清）

- `session-<sessionId>.json`：`{ sessionId, lastSequence, subagents: [{ id, agentType, startedAtMs }] }`，`subagents` 只放跑中的。`SubagentStop` 直接把那筆移除，檔案大小只跟同時在跑的 sub 數量有關，不會越長越大。
  - 舊版留下、`status` 是 `"done"` 的項目，下一次事件讀檔時就丟掉。
  - 同一個 sub 還在清單裡又收到 `SubagentStart` 時只留一筆（保留原本的啟動順序）；已經移除後再收到它的 `SubagentStart`（resume）就重新列在最後面。
- `pane-<HERDR_PANE_ID>.json`：給 popup viewer 讀的對照檔，**合約固定**：`{"sessionId","transcriptPath","cwd","updatedAtMs"}`。

寫之前先檢查 `subagent-watch` 資料夾：必須是自己 uid 的、不是 symlink、權限 `0700`，不符合就什麼都不寫（`XDG_RUNTIME_DIR` 本身不存在時也不會幫它建）。

兩個檔案都用「寫暫存檔再 `rename`」，viewer 不會讀到寫一半的 JSON；暫存檔名是隨機的、用 `wx` 建立，不會跟著預先放好的 symlink 寫到別的檔案。

同一個 session 的 read-modify-write 用 `session-<id>.json.lock` 串起來，平行啟動多個 sub 也不會掉資料：

- lock 內容是持有者的 pid、啟動時間（`/proc/<pid>/stat` 第 22 欄）與建立時間。先寫暫存檔再 `link` 成 lock（跟 `wx` 一樣「不存在才建立」），別人讀不到沒寫完的內容。
- 判斷失效：`process.kill(pid, 0)` 查不到、process 是 zombie，或同一個 pid 但啟動時間不同（pid 被重用）。舊版留下的空 lock 沒有 pid，超過 2 秒才算失效；任何 lock 超過 10 秒都算失效（pid 查不準時的保險，hook 本身不到 1 秒就結束）。
- 接管：先用 `link` 搶 `<lock>.break-<inode>` 這個名字，搶到而且確認還是判定失效的那個 inode 才刪 lock，不會刪到別人剛建好的新 lock。搶到的 process 若在刪之前被砍掉，留下的 `.break-*` 超過 2 秒就清掉。
- 釋放時確認路徑上還是自己建的那個 inode 才刪。

### herdr 回報

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token sub1=├─ Explore ● --token sub2=└─ Plan ● \
  --clear-token sub3 --clear-token sub4 --clear-token sub5
```

最後一個跑中的 sub 結束時，五個 token 全部用 `--clear-token` 清掉。

- 只用一個 source `subagent.watch`：herdr 每個 pane 一生最多 32 個 sequenced source，清掉也不會還。
- `--seq` 用 `Date.now()`，同一毫秒連發時取「上一筆 + 1」，保證遞增（herdr 會忽略比較舊的 seq）。
- 排序：照啟動時間。跑中的超過 5 個時第 5 行改成 `└─ +N more`，N 只算跑中、沒列出來的。
- herdr token 上限 80 字、會移除控制字元。hook 先拿掉控制字元（`\p{Cc}`）和格式字元（`\p{Cf}`，例如 U+202A–202E、U+2066–2069 的 bidi 控制、U+200B–200F 的零寬字元），不讓 `agent_type` 把側邊欄的字反轉或藏起來；太長時截斷成 `…`，保證 `●` 留在行尾。
- herdr 路徑用 `HERDR_BIN_PATH`，沒有才找 PATH 上的 `herdr`，而且只看 PATH 裡的絕對路徑：空項目和 `node_modules/.bin` 這類相對路徑是相對於目前資料夾，也就是使用者正在開的 repo，裡面放的 `herdr` 不能被執行。`open-action.mjs`、`scripts/setup.mjs`、`bin/run.sh` 的通知都用同一套規則。

### 不干擾 Claude session 的設計

這個 hook 是全域的，套用到所有 Claude session：

- 永遠 exit 0、stdout 不輸出（herdr 的輸出也導到 `ignore`），整體預算 800 ms（herdr 逾時直接 `SIGKILL`）；`settings.json` 的 timeout 是 5 秒當保險。
- 沒有 `HERDR_PANE_ID`、沒有 `XDG_RUNTIME_DIR`、找不到 herdr 執行檔 → 什麼都不寫，直接結束。
- `bin/run.sh` 找不到 Node.js 22+ 時，對這個 hook 一律安靜地 exit 0（其他入口才印錯誤）。
- `agent_type` 是空字串的事件略過：Claude Code 內部 agent（prompt suggestion、`/btw`）也會觸發 `SubagentStop`。
- 沒看過 `SubagentStart` 的 `SubagentStop` 略過。
- `subagent-watch` 資料夾不是自己的、是 symlink、或權限不是 `0700` → 什麼都不寫。
- 同一個 pane 裡別的 Claude session 的事件略過（例如 pane 裡的 claude 用 Bash 跑 `claude -p`）：子 process 繼承同一個 `HERDR_PANE_ID`，不擋的話會蓋掉主 session 的樹和對照檔。判斷方式：
  - 先問 `herdr pane get <pane>` 的 `agent_session`（herdr 的 claude integration 回報）：跟 payload 的 `session_id` 一樣才更新；不一樣、或是別的 agent 的 session 就略過。最多等 300 ms，而且不會吃掉回報 herdr 的最低預算。
  - herdr 拿不到 `agent_session`（沒裝 integration、herdr 沒回應）才退回看祖先 process：有兩組以上 `claude` 就略過。直接父子相鄰的 `claude` 只算一組，所以名為 claude、沒有 `exec` 的 wrapper script 不會讓每個事件都被當成巢狀；Bash tool 跑的指令一定隔著一層 shell，巢狀的 `claude -p` 仍然算第二組。

### 已知限制

- session 在還有 sub 跑中時結束或換 session，舊的樹狀行會留著，直到這個 pane 下一次 sub agent 事件才被覆蓋（只接了 `SubagentStart`／`SubagentStop`，沒接 `SessionStart`／`SessionEnd`）。
- 某個 sub 的 `SubagentStop` 沒記到（例如等 lock 超過時間預算，hook 直接放棄這次事件），那一行在同一個 session 裡不會自己消失（那個 sub 之後再收到一次 `SubagentStop` 才會拿掉）；換 session 後的下一次 sub 事件才會蓋掉。
- `agent_session` 是 herdr 的 claude integration 在 `SessionStart` 回報的；它的 hook 只排除 sub agent（有 `agent_id` 的事件），沒有排除巢狀的 `claude -p`。如果巢狀 session 的回報蓋掉了 pane 的 `agent_session`，主 session 之後的事件會被當成別的 session 略過，直到主 session 下一次 `SessionStart`（`/clear`、`/resume` 等）。herdr server 會不會擋這種回報沒有驗證。
- 祖先 process 的退路分不出 `exec claude -p` 這種寫法（巢狀的 claude 會跟主 claude 直接相鄰，被當成同一組）。
- `●`、`─` 是 ambiguous width 字元，實際寬度看終端機設定。

## setup 會加什麼

由 `subagent.watch.setup` action（或 `sh bin/run.sh scripts/setup.mjs`）寫入，規則與衝突處理見 [README](../README.zh-TW.md#安裝) 的「安裝」。

`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` 的 `hooks` 底下（其他設定不動）：

```json
"SubagentStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "sh \"<plugin 目錄>/bin/run.sh\" \"<plugin 目錄>/hooks/sidebar-hook.mjs\"",
        "timeout": 5
      }
    ]
  }
],
"SubagentStop": [ 同上 ]
```

`<plugin 目錄>` 是 setup 執行當下 plugin 的絕對路徑（`herdr plugin install` 的 managed checkout 或 `herdr plugin link` 的資料夾）。node 不寫進 command，由 `bin/run.sh` 每次找。

setup／remove 認自己的 hook 是比對整個 `command`：必須正好是上面這種寫法（`run.sh` 與 `hooks/sidebar-hook.mjs` 在同一個絕對路徑的 plugin 目錄底下），或是有 launcher 之前手動加的舊寫法 `<node 絕對路徑> <絕對路徑>/hooks/sidebar-hook.mjs`（setup 會原地升級成新寫法）。別的工具的 hook 只是檔名剛好叫 `sidebar-hook.mjs` 不會被改或刪。Claude Code 官方 hooks 文件列的 hook 欄位裡沒有可以放識別資訊的，所以只能比對 command。

寫檔方式：

- 兩個檔案改動前都備份成同資料夾的 `<檔名>.subagent-watch.bak`，**只備份第一次**：`.bak` 已經存在就不覆寫，保留最早的原始檔（想重新備份就自己刪掉舊的 `.bak`）。
- 設定檔是 symlink（例如指向 dotfiles repo）時，寫到它指向的真實檔案，symlink 本身留著；指向不存在的檔案就報錯、不改。
- `config.toml` 的新內容先寫成真實檔案旁邊的暫存檔，用 `HERDR_CONFIG_PATH` 指向它跑 `herdr config check`，通過才 `rename` 過去；沒通過就刪掉暫存檔，原檔完全沒動過，不需要還原。
- `settings.json` 照原檔的縮排、換行字元（CRLF 寫回仍是 CRLF）與結尾換行寫回；remove 沒有東西可拿掉時不寫檔。

`config.toml`（`$HERDR_CONFIG_PATH`，沒設就是 `${XDG_CONFIG_HOME:-~/.config}/herdr/config.toml`）新增，每段都包在 `# >>> subagent.watch` ／ `# <<< subagent.watch` 之間：

```toml
[[keys.command]]
key = "prefix+."
type = "plugin_action"
command = "subagent.watch.open"
description = "sub agent viewer"

[ui.sidebar.agents.rows_by_agent]
claude = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$sub1", bold = true, dim = false }],
  [{ token = "$sub2", bold = true, dim = false }],
  [{ token = "$sub3", bold = true, dim = false }],
  [{ token = "$sub4", bold = true, dim = false }],
  [{ token = "$sub5", bold = true, dim = false }],
]
```

前兩行是 herdr 文件裡的預設 rows。`rows_by_agent` 會整個取代 `rows`，不是接在後面，所以預設的兩行要寫進來；如果你在 `[ui.sidebar.agents]` 自訂過 `rows`，claude 那一列會改回這兩行（setup 會提醒）。

`$sub*` 用 inline style table，一律 `bold`：側邊欄只會出現跑中的 sub，不用區分狀態。

- 不指定 `fg`：顏色全部跟著 herdr theme，換 theme 也不用改這五行。
- `dim = false`：herdr 文件寫明沒寫的欄位沿用 token 的 contextual style，明確寫 `false` 才會拿掉那個修飾，這裡確保樹狀行不會被畫成 dim。

舊版 setup 每行多寫了 `rules = [{ contains = "✓", bold = false }]`。現在不會再出現 `✓`，那條 rule 留著也沒有作用。setup 看到 claude rows 已經有 `$sub1` 就當成設定好，不會改寫；想拿掉就自己刪，或（在 marker 裡的話）先跑 remove 再跑 setup。

## 怎麼移除

1. 跑 `herdr plugin action invoke subagent.watch.remove`（或 `sh bin/run.sh scripts/setup.mjs --remove`）：拿掉 `settings.json` 裡本 plugin 的 hook（認法見「setup 會加什麼」）與 `config.toml` 裡 marker 之間的內容，然後 `herdr server reload-config`。
2. 沒有 marker、手動加的設定要自己刪：`settings.json` 刪掉 `command` 指向 `sidebar-hook.mjs` 的那筆（陣列空了就把整個 key 拿掉）；`config.toml` 刪掉 `prefix+.` 那段 `[[keys.command]]` 和 `claude` rows 裡的 `$sub1`…`$sub5`，再 `herdr server reload-config`。
3. 清掉 pane 上殘留的 token（每個有 claude 的 pane 各跑一次）：

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch --seq "$(date +%s%3N)" \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

4. 狀態檔在 `$XDG_RUNTIME_DIR/subagent-watch/`，重開機會自動清掉，也可以手動刪掉這個資料夾。

## 測試

```
node --test test/sidebar*.test.mjs test/security-*.test.mjs
```

涵蓋 payload 解析、狀態更新（stop 移除、沒看過 start 的 stop 略過、舊版 `done` 項目丟掉）、樹狀行（start 兩個 → stop 一個剩 `└─` → 全部 stop 全清、`+N more` 只算跑中、80 字截斷、bidi／零寬字元拿掉）、seq 遞增、非 herdr 環境靜默、沒有 `HERDR_BIN_PATH` 時改找 PATH 上的 herdr（相對路徑的 PATH 項目不算）、用 `agent_session` 判斷 pane 的 session（名為 claude 的 wrapper 照常更新、巢狀 `claude -p` 略過，用真的 process 樹測）、狀態資料夾檢查（symlink、權限、owner、預放的 symlink）、lock（失效判斷、接管不刪到別人的新 lock、多個 hook 搶同一個失效 lock 不掉資料）、平行啟動不掉資料，以及用假的 herdr 執行檔實際跑 script（檢查 exit 0、stdout 空、1 秒內結束）。
