# CHANGELOG

只記決策：為什麼這樣定。改了什麼看 git log，現況看 features.md。

## 2026-11-01

- CI：只改溝通用 md（根目錄 `*.md` 與 `docs/**/*.md`）時，`test`、`test-macos` 用 job 層 `if` 跳過；由 `changes` job 跑 `scripts/ci-needs-test.mjs` 判斷，改動清單取不到時視為要跑。理由：文件改動不需要跑測試。不用 workflow 層 `paths-ignore`，因為 main 的必過 check `test` 會停在 Pending 擋住 merge，job 層 skip 會回報 Success。不用第三方 paths filter action、沿用 pin SHA 的 action，是為了減少供應鏈面。判斷邏輯寫成純函式加 `node --test`，跟 repo 既有的測試方式一致。
- 加 `REVIEW.md`（英文、自含，三節 When to review／What to look at, what to skip／Severity），`CLAUDE.md` 在 Reading Notes 前用一句指向它。理由：code reviewer 是共用的 agent，只讀 repo 檔案與 `CLAUDE.md`；用英文是因為 reviewer 的 prompt 是英文；不用個人流程的內部用語，因為 reviewer 看不懂。review 時機定為一個 branch 合回 main 前 review 一次、小改動不 review、每個 commit 前只跑語法 check，避免無異議的 review 浪費。指向句不放進 Reading Notes，因為那段格式固定。
- `.gitignore` 加 `.cache/`。理由：md-review 的意見檔寫在 `.cache/md-review/`，不該進 git。
