# my-mods

Claude Code mods（hooks plugins）。

- `grill-choices`：`/grill-with-docs` 的提問改成 AskUserQuestion 選擇題，可自行輸入。
- `ship`：`/ship [補充說明]`，驗證 → 獨立 sonnet code-review → 確認 commit 訊息 → commit → push。
- `context-buddy`：Claude 娃娃，常駐輸入框上方，依 context 用量說話；每個「收尾段落且用量 ≥50%」都用 haiku 判斷一次（依下一份工作與目前脈絡）；適合開新 session 時顯示「換新 session」按鈕，自動寫交接摘要、/clear 並送出接續 prompt。已取代 `handoff-button`。
- `action-chips`：每次回覆後在輸入框上方排出小框框——回覆中的檔案與網址點了開啟（可執行檔只在 Finder 顯示）、指令點了複製；標籤由 haiku 寫成「這是什麼」（如 web demo、部署指令），依回覆順序由左至右、過長換行。

## 安裝

```
/plugin install grill-choices --marketplace cch-agent/claude-mods
/plugin install ship --marketplace cch-agent/claude-mods
/plugin install context-buddy --marketplace cch-agent/claude-mods
/plugin install action-chips --marketplace cch-agent/claude-mods
```

### 從 handoff-button 遷移

`handoff-button` 已移除，功能併入 `context-buddy`（其「換新 session」按鈕取代了舊的「交接」按鈕）。若曾安裝，請執行 `/plugin uninstall handoff-button@my-mods` 再 `/reload-plugins`（會一併清掉 `settings.json` 的 `enabledPlugins` 殘留項），否則舊的「交接」按鈕會與新按鈕同時出現、可能重複交接。

> 安裝指令的 `--marketplace cch-agent/claude-mods` 是 GitHub 來源；本機目錄來源的 marketplace 名稱為 `my-mods`，所以解除安裝用 `@my-mods`。
