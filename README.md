# herdr-subagent-watch

herdr plugin `subagent.watch`：用 popup 即時顯示「從哪個 Claude Code pane 開的，就看那個 session 的 sub agent 在做什麼」。純 Node 內建模組，不需要 `npm install`。

## 安裝

```sh
herdr plugin link /home/hotpapa/Documents/Projects/herdr-subagent-watch
herdr plugin action list --plugin subagent.watch   # 應該看到 open
```

manifest 裡的 node 寫死 `/home/hotpapa/.local/share/fnm/aliases/default/bin/node`：shell 裡的 `node` 在 fnm multishell 暫存路徑，session 結束就消失，不能寫進 manifest。

## 開啟

- action：`subagent.watch.open`（快捷鍵 `prefix+.` 綁在這個 id）。`open-action.mjs` 從 `HERDR_PLUGIN_CONTEXT_JSON` 讀 `focused_pane_id`，再呼叫 `herdr plugin pane open --plugin subagent.watch --entrypoint viewer --env SUBAGENT_WATCH_PANE_ID=<pane>`（herdr 路徑用 `HERDR_BIN_PATH`，沒有才用 `/opt/herdr/bin/herdr`）。
- 也可以直接 `herdr plugin pane open --plugin subagent.watch --entrypoint viewer`；這時 viewer 改用 popup 自己的 context JSON 裡的 `focused_pane_id`。

popup 開、關都手動：所有 sub 結束也不會自己關。

## 操作

| 按鍵 | 作用 |
| --- | --- |
| `←` / `→` | 切換 tab（循環） |
| `q` / `Esc` / `Ctrl+C` | 關閉 |

- tab 列：`●` 跑中、`✓` 結束，不帶數字，沒有 1–9 直跳。結束的 tab 留著。
- tab 名稱用 meta 的 `agentType`；同一個 type 出現多次時接 `description` 片段區分。
- 新的 `agent-*.jsonl` 出現就即時多一個 tab（`fs.watch` 監看 `subagents/`，每秒 polling 備援）。第一次有 tab 時選最新的跑中 sub，之後選取跟著 agent 走，新 tab 不會搶走目前看的。
- 事件一行一個：`HH:MM:SS  <tool>  <參數摘要>`。Bash 取 `command`、Read／Edit／Write 取 `file_path`、Grep 取 `pattern`、WebFetch 取 `url`、Agent 取 `description`，其他取第一個字串欄位；thinking 顯示 `thinking...`。只顯示 assistant 的 `tool_use` 與 thinking，不顯示 `tool_result` 內容。超出高度捲到最新，resize 會重畫。
- 還沒有 sub 時顯示 `No sub agents yet in this session`；完全找不到 session 時顯示 `No Claude Code session found for this pane` 和每一步失敗的原因。

## 怎麼找到 pane 對應的 session

pane id 來源依序：`SUBAGENT_WATCH_PANE_ID`（open action 傳入）→ context JSON 的 `focused_pane_id` → `HERDR_PANE_ID`（非 popup 時）。拿到 pane 之後依序嘗試：

1. **herdr**：`herdr pane get <pane>` 的 `agent_session`（herdr 的 claude integration 會回報，實測 `{"agent":"claude","kind":"id","value":"<session-id>"}`）。用 session id 在 `~/.claude/projects/*/` 找 `<session-id>.jsonl`。session 剛開還沒寫 transcript 時會等它出現，不會退回去猜。
2. **pane map**：sidebar hook 寫的 `$XDG_RUNTIME_DIR/subagent-watch/pane-<paneId>.json`（`sessionId`、`transcriptPath`、`cwd`、`updatedAtMs`）。
3. **猜**：用 pane 的 cwd 對到 `~/.claude/projects/<cwd 的 / 換成 ->/`，取最新修改的 `<session-id>.jsonl`。底部分隔線會標 `(guessed: latest session)`：同一個資料夾開多個 Claude Code 時可能猜錯。`/var/home/...` 與 `/home/...` 兩種寫法都會試（Fedora Atomic 的 home 在 `/var/home`）；另外也試把所有非英數字元換成 `-` 的寫法（未驗證 Claude Code 是否這樣編碼含 `.` 的路徑）。

`CLAUDE_CONFIG_DIR` 有設定時改看 `$CLAUDE_CONFIG_DIR/projects`。

## 資料來源與結束判斷

- sub transcript：`~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl`，旁邊 `agent-<id>.meta.json`（`agentType`、`description`）。只讀新增的 bytes；壞掉或不完整的行直接跳過。格式是 Claude Code internal，升版可能改。
- 判斷 sub 結束（任一成立就 `✓`），依據是本機 117 個真實 sub transcript：
  1. sub JSONL 出現 `tool_use` `SubagentHandback`（85 個背景 sub 都是這樣結束）。
  2. 最後一筆 assistant 的 `stop_reason` 是 `end_turn`（27 個 `fork` sub 沒有 `SubagentHandback`，都是這樣結束）。
  3. main transcript 出現 `<task-notification>`，`<task-id>` 是這個 agent、`<status>` 是 `completed`／`killed`／`failed`（被 kill 的 sub 只有這個訊號）。
  4. 備案：transcript 超過 10 分鐘沒寫入。門檻對齊 Bash tool 單次最長 10 分鐘，避免把正在等指令的 sub 誤判。這時結束行顯示 `no writes for 10 min`，之後若又寫入會變回 `●`。
- 結束訊號比最後一筆 assistant 活動早時不算數：sub 被 resume 後會回到 `●`。
- 前景 sub：本機的 meta 全是 `"requestShape":"background"`，沒有前景 sub 的樣本，前景 sub 的結束訊號**未驗證**；預期會落在 2（`end_turn`）或 4（10 分鐘備案）。

## 模式

```sh
node viewer.mjs                      # 互動模式（popup 用這個）
node viewer.mjs --once               # 印一張畫面到 stdout 後 exit 0，不需要 TTY
node viewer.mjs --demo               # 假資料，規則與正式版相同（8 秒後會多一個 tab）
node viewer.mjs --session <path>     # 手動指定 main transcript（<session-id>.jsonl）
node demo.mjs                        # 等同 viewer.mjs --demo
```

## 測試

```sh
cd /home/hotpapa/Documents/Projects/herdr-subagent-watch && node --test
# 或
node --test '/home/hotpapa/Documents/Projects/herdr-subagent-watch/test/**/*.test.mjs'
```

Node 22 的 `node --test` 只吃檔案或 glob，傳資料夾（`node --test test/`）會被當成要載入的 module 而失敗。pty 測試需要 util-linux 的 `script`，沒有就跳過。

## 測 open action 不開 popup

`$HERDR_PLUGIN_STATE_DIR/dry-run` 存在（或 command 多帶 `--dry-run`）時，`open-action.mjs` 只把 context 與將要執行的指令寫進 `$HERDR_PLUGIN_STATE_DIR/open-action.log` 並印到 stdout，不開 popup。

## 已知限制

- `◀ ▶ ● ✓ ─ …` 是 East Asian ambiguous width 字元，terminal 設成 ambiguous = wide 時畫面會錯位。
- `SubagentHandback` 這類長 tool 名稱會把該行的參數往右推，不對齊。
- 視窗窄時 tab 列只顯示選取的 tab 附近幾個，兩端箭頭變紫色代表那一側還有藏起來的 tab。
