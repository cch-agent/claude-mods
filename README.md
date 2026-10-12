# my-mods

Claude Code mods（hooks plugins）。

- `grill-choices`：`/grill-with-docs` 的提問改成 AskUserQuestion 選擇題，可自行輸入。
- `handoff-button`：context 用到 70% 時，輸入框上方出現「交接」按鈕，寫摘要、存檔、清空對話並把摘要當新對話第一句送出。
- `ship`：`/ship [補充說明]`，驗證 → 獨立 sonnet code-review → 確認 commit 訊息 → commit → push。
- `context-buddy`：Claude 娃娃，常駐輸入框上方，依 context 用量說話；段落結束且用量偏高時，用 haiku 判斷是否該開新 session。

## 安裝

```
/plugin install grill-choices --marketplace cch-agent/claude-mods
/plugin install handoff-button --marketplace cch-agent/claude-mods
/plugin install ship --marketplace cch-agent/claude-mods
/plugin install context-buddy --marketplace cch-agent/claude-mods
```

### 外掛順序注意

`context-buddy` 應在 `handoff-button`「之前」安裝／登記，才會位於外層（畫在 handoff-button 的按鈕下方並附上「可按『交接』」提示）。否則 context ≥70% 時，娃娃可能被 handoff-button 的 band 取代（按鈕仍可用）。
