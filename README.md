# cch

Claude Code mods（hooks plugins）。

- `grill-choices`：`/grill-with-docs` 的提問改成 AskUserQuestion 選擇題，可自行輸入。
- `ship`：`/ship [補充說明]`，驗證 → 獨立 sonnet code-review → 確認 commit 訊息 → commit → push。
- `action-chips`：每次回覆後在輸入框上方排出小框框——回覆中的檔案與網址點了開啟（可執行檔只在 Finder 顯示）、指令點了複製；標籤由 haiku 寫成「這是什麼」（如 web demo、部署指令），依回覆順序由左至右、過長換行。

## 安裝

```
/plugin marketplace add cch-agent/claude-mods
/plugin install grill-choices@cch
/plugin install ship@cch
/plugin install action-chips@cch
/reload-plugins
```

> marketplace 名稱為 `cch`（見 `.claude-plugin/marketplace.json`），安裝與解除安裝都用 `@cch`。從舊名 `my-mods` 遷移：先 `/plugin uninstall <mod>@my-mods`、`/plugin marketplace remove my-mods`，再依上方步驟重裝。
