# 側邊欄 sub agent 樹狀行

herdr 側邊欄 claude 那一列底下，用最多 5 行顯示這個 session 的 sub agent：

```
<state_icon> <workspace> · <tab>
claude
├─ Explore ●
├─ general-purpose ●
└─ Plan ✓
```

`●` 跑中、`✓` 結束，不帶編號。popup viewer（`prefix+.`）是另一回事，見 `herdr-plugin.toml`。

## 原理

1. Claude Code 啟動／結束 sub agent 時觸發 `SubagentStart`／`SubagentStop` hook，經 `bin/run.sh` 找到 node 後執行 `hooks/sidebar-hook.mjs`，payload 從 stdin 進來。
2. hook 更新狀態檔，再呼叫 `herdr pane report-metadata` 把樹狀行寫進 pane token `sub1`…`sub5`。
3. `config.toml` 的 `rows_by_agent.claude` 多了 `$sub1`…`$sub5` 五行；herdr 文件寫明沒回報的 token 會讓那一行整行消失，所以平常看不到空行（畫面上實際效果尚待使用者確認）。

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

- `session-<sessionId>.json`：`{ sessionId, lastSequence, subagents: [{ id, agentType, status: "running" | "done", startedAtMs, endedAtMs }] }`
- `pane-<HERDR_PANE_ID>.json`：給 popup viewer 讀的對照檔，**合約固定**：`{"sessionId","transcriptPath","cwd","updatedAtMs"}`。

兩個都用「寫暫存檔再 `rename`」，viewer 不會讀到寫一半的 JSON。同一個 session 的 read-modify-write 用 `session-<id>.json.lock`（`open` 的 `wx` flag）串起來，平行啟動多個 sub 也不會掉資料；lock 超過 2 秒沒放視為失效。

### herdr 回報

```
herdr pane report-metadata <HERDR_PANE_ID> --source subagent.watch --seq <seq> \
  --token sub1=├─ Explore ● --token sub2=└─ Plan ✓ \
  --clear-token sub3 --clear-token sub4 --clear-token sub5
```

- 只用一個 source `subagent.watch`：herdr 每個 pane 一生最多 32 個 sequenced source，清掉也不會還。
- `--seq` 用 `Date.now()`，同一毫秒連發時取「上一筆 + 1」，保證遞增（herdr 會忽略比較舊的 seq）。
- 排序：跑中的照啟動時間排前面，再來是最近結束的。超過 5 個時第 5 行改成 `└─ +N more`。
- herdr token 上限 80 字、會移除控制字元：`agent_type` 太長時截斷成 `…`，保證 `●`／`✓` 留在行尾。
- herdr 路徑用 `HERDR_BIN_PATH`，沒有才找 PATH 上的 `herdr`。

### 不干擾 Claude session 的設計

這個 hook 是全域的，套用到所有 Claude session：

- 永遠 exit 0、stdout 不輸出（herdr 的輸出也導到 `ignore`），整體預算 800 ms（herdr 逾時直接 `SIGKILL`）；`settings.json` 的 timeout 是 5 秒當保險。
- 沒有 `HERDR_PANE_ID`、沒有 `XDG_RUNTIME_DIR`、找不到 herdr 執行檔 → 什麼都不寫，直接結束。
- `bin/run.sh` 找不到 Node.js 22+ 時，對這個 hook 一律安靜地 exit 0（其他入口才印錯誤）。
- `agent_type` 是空字串的事件略過：Claude Code 內部 agent（prompt suggestion、`/btw`）也會觸發 `SubagentStop`。
- 沒看過 `SubagentStart` 的 `SubagentStop` 略過。
- 祖先 process 裡有兩個以上 `claude`（例如 pane 裡的 claude 用 Bash 跑 `claude -p`）→ 略過。子 process 繼承同一個 `HERDR_PANE_ID`，不擋的話會蓋掉主 session 的樹和對照檔。

### 已知限制

- session 結束或換 session 後，舊的樹狀行會留著，直到這個 pane 下一次 sub agent 事件才被覆蓋（只接了 `SubagentStart`／`SubagentStop`，沒接 `SessionStart`／`SessionEnd`）。
- 結束的 sub 不會自己消失：長 session 跑過很多 sub 後，側邊欄會固定佔 5 行（4 個最近的 + `+N more`）。
- `●`、`✓`、`─` 是 ambiguous width 字元，實際寬度看終端機設定。

## setup 會加什麼

由 `subagent.watch.setup` action（或 `sh bin/run.sh scripts/setup.mjs`）寫入，規則與衝突處理見 README 的「安裝」。

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
  [{ token = "$sub1", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],
  [{ token = "$sub2", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],
  [{ token = "$sub3", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],
  [{ token = "$sub4", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],
  [{ token = "$sub5", bold = true, dim = false, rules = [{ contains = "✓", bold = false }] }],
]
```

前兩行是 herdr 文件裡的預設 rows。`rows_by_agent` 會整個取代 `rows`，不是接在後面，所以預設的兩行要寫進來；如果你在 `[ui.sidebar.agents]` 自訂過 `rows`，claude 那一列會改回這兩行（setup 會提醒）。

`$sub*` 用 inline style table 加 `rules`，只用粗細區分狀態：跑中（`●`）`bold`，結束（`✓`，`contains = "✓"` 那條 rule）不 `bold`。

- 不指定 `fg`：顏色全部跟著 herdr theme，換 theme 也不用改這五行。
- `dim = false`：herdr 文件寫明沒寫的欄位沿用 token 的 contextual style，明確寫 `false` 才會拿掉那個修飾，這裡確保樹狀行不會被畫成 dim。

## 怎麼移除

1. 跑 `herdr plugin action invoke subagent.watch.remove`（或 `sh bin/run.sh scripts/setup.mjs --remove`）：拿掉 `settings.json` 裡指向 `sidebar-hook.mjs` 的 hook 與 `config.toml` 裡 marker 之間的內容，然後 `herdr server reload-config`。
2. 沒有 marker、手動加的設定要自己刪：`settings.json` 刪掉 `command` 指向 `sidebar-hook.mjs` 的那筆（陣列空了就把整個 key 拿掉）；`config.toml` 刪掉 `prefix+.` 那段 `[[keys.command]]` 和 `claude` rows 裡的 `$sub1`…`$sub5`，再 `herdr server reload-config`。
3. 清掉 pane 上殘留的 token（每個有 claude 的 pane 各跑一次）：

   ```
   herdr pane report-metadata <pane_id> --source subagent.watch --seq "$(date +%s%3N)" \
     --clear-token sub1 --clear-token sub2 --clear-token sub3 --clear-token sub4 --clear-token sub5
   ```

4. 狀態檔在 `$XDG_RUNTIME_DIR/subagent-watch/`，重開機會自動清掉，也可以手動刪掉這個資料夾。

## 測試

```
node --test test/sidebar*.test.mjs
```

涵蓋 payload 解析、狀態更新、樹狀行（含 `+N more`、80 字截斷）、seq 遞增、非 herdr 環境靜默、沒有 `HERDR_BIN_PATH` 時改找 PATH 上的 herdr、巢狀 `claude -p` 略過、平行啟動不掉資料，以及用假的 herdr 執行檔實際跑 script（檢查 exit 0、stdout 空、1 秒內結束）。
