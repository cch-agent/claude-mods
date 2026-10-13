# system1 第 2 階段設計：grilling 收尾拆題 → 規格檔

已與使用者定案（2026-10-13）。實作 agent 以本文件為準。

## 使用者決定
- 不新增 slash command。拆題接在名稱含 `grill` 或 `plan` 的 skill（如 `grilling`、`grill-with-docs`、`writing-plans`）收尾，每回合只附加一次。
- 規格、狀態、檢查紀錄全部放同一個檔：`<toplevel>/context/specs/<id>.json`，進版控，不設指標檔。
- 使用者確認規格後停下，實作從使用者下一個指令開始。
- Jev 每條只問三題（single_condition、self_contained、testable）。
- 已確認的規格經 `submit_plan` 修改 → 同一檔原地回 draft、清空 confirmed_at；重新確認前沒有任何規格生效（第 3 階段不做事）。（原定「由上一份 confirmed 生效」與單一檔案規則衝突，改採此行為。）
- schema 錯誤的送出不寫檔、不計入輪數（沒有檔可記）；無限重送由 planner 的 maxTurns 40 兜底。
- planner 只用 `$.agent.register` 以 `PLANNER_PROMPT` 註冊，不放 `agents/planner.md`（避免重複註冊與兩份內容漂移）。

## 元件總覽
| 元件 | 位置 | 職責 |
|---|---|---|
| `skill.prompt` hook | register.ts | skill 名稱（不分大小寫，含 plugin 前綴）符合 `/grill|plan/i` 時附加 `SPEC_TAIL`。同一回合只附加一次：閉包旗標 `appendedThisTurn`，附加後設 true，`prompt.submit` hook 重設為 false（grill-with-docs 會再載入 grilling，兩者都命中，只有先載入者被附加）；熱重載會重設旗標，可接受。仍保留 `!text.includes(SPEC_TAIL)` 檢查、原文在前，與 grill-choices 的附加共存。 |
| `system1:planner` agent | `$.agent.register`（`PLANNER_PROMPT`） | model opus；tools `[Read, Bash, mcp__system1__submit_plan]`（此版本無 Grep/Glob；Bash 只做唯讀搜尋）；maxTurns ≈ 40；`agent.spawn` hook 強制前景執行，確保回報後才附摘要。 |
| `mcp__system1__submit_plan` 工具 | register.ts | 唯一寫入路徑：validateSpec → 第 2 層 → 第 3 層（Jev）→ 寫檔 → 回傳 formatReport。`isDeferred: false`。忽略呼叫者傳入的 status/checks/confirmed_at/base_commit。 |
| `mcp__system1__confirm_plan` 工具 | register.ts | `$.ui.ask` 問「共 N 條，M 條有標記，K 個未解問題，是否確認？」選項：確認／修改（Other 輸入）／取消。確認 → status=confirmed、confirmed_at、base_commit=HEAD，盡力把其他 confirmed 改 superseded。`$.ui.ask` reject（如 -p 模式）→ 維持 draft。回傳路徑與 base_commit。 |
| 寫入防護 | register.ts `tool.call` | Write/Edit/MultiEdit/NotebookEdit 的目標經 `$.fs.stat(p,{resolve:true}).realPath` 解析後，`isGuardedSpecPath` 為真 → `{ deny: '規格檔只能經 mcp__system1__submit_plan（帶 spec_id）修改；修改後需重新確認' }`。不攔 Bash。 |
| Agent hook（第 1 階段） | register.ts | `subagent_type` 以 `system1:` 開頭 → 不打 Jev、不改 model；若為 `system1:planner`，`next(e)` 回來後讀最新 draft，把 formatReport 摘要放進結果的 `context`。 |

根目錄：`$.process.run(['git','rev-parse','--show-toplevel'])`，失敗則 `$.session.cwd()`。

## 規格檔 schema（schema: 1）
```json
{ "schema": 1,
  "id": "20261013-1530-extract-empty",
  "status": "draft | confirmed | superseded",
  "created_at": "ISO UTC", "confirmed_at": "ISO UTC（confirmed 才有）",
  "base_commit": "confirm 時的 HEAD",
  "intent": "一句話本意",
  "requirements": [ { "id": "R1", "text": "...", "verify_by": "test|jev|agent" } ],
  "out_of_scope": ["..."],
  "open_questions": [ { "req_id": "R3", "question": "...", "options": ["...", "..."], "recommended": 0, "why": "..." } ],
  "checks": {
    "round": 1, "revision": 1, "agent": "<agentId|main>",
    "layer2": { "R1": ["conjunction:且"] },
    "layer3": { "status": "ok|skipped:no-key|timeout|error|partial-timeout",
                "items": { "R1": { "single_condition": 0.91, "self_contained": 0.4, "testable": 0.8, "verdict": "unsure" } } } } }
```
- id：`YYYYMMDD-HHMM-<slug>`，slug 由 planner 提供，mod 清理為 `[a-z0-9-]`，撞名加 `-2`、`-3`。
- 「目前生效」：`pickActiveSpec` — `context/specs/` 第一層 `*.json`，略過解析失敗與 `schema !== 1`，取 `status === 'confirmed'` 中 `confirmed_at` 最新者，同時間取 id 字典序較大者。superseded 只是給人看的標記，規則不依賴它。

## 第 2 層（程式、確定性）
- schema 錯誤 → 回錯誤、不寫檔、不計入輪數：缺 intent、requirements 為空、id 不符 `^R\d+[a-z]?$`、id 重複、verify_by 不在集合、out_of_scope 非字串陣列、open_questions 格式錯（options 2–4 個、recommended 為有效索引、req_id 必須存在）。
- 可疑標記（只標記）：連接詞（且、以及、並且、並、同時、`, and`）→ `conjunction:<詞>`；指代詞（剛才、上述、前述、這個、那個、該、above）→ `pronoun:<詞>`；長度 > 80 字 → `long:<長度>`。

## 第 3 層（Jev）
- 每條需求一個請求，`state = { requirement: text, verify_by }`（不放 intent 或其他條目）。併發上限 4；整批總逾時 8 秒（`$.clock.sleep` + `Promise.race`，綁 `next.signal`/工具的 abort）；逾時只影響未回來的條目（status `partial-timeout`）。每份最多 30 條，超過的不送並註明。
- 題目（`true` = 通過）：
```js
single_condition: { type:'noul',
  instructions:{ question:'`requirement` 是否只描述一個可獨立判斷是否滿足的條件？' },
  criteria:{ true:'只有一個條件，一次檢查即可判定',
             false:'含兩個以上可分開判斷的條件，例如以「且／並／以及」連接，或同時規定行為與修改範圍' } }
self_contained: { type:'noul',
  instructions:{ question:'只讀 `requirement` 這一句、不看任何其他資料，能否判斷一段程式變更是否滿足它？' },
  criteria:{ true:'寫明具體對象（檔名、函式、數值或行為），可直接比對',
             false:'需要句外脈絡才知道指什麼（如「剛才、上述、這個」），或描述模糊到無法判定' } }
testable: { type:'noul',   // 只有 verify_by === 'test' 才問
  instructions:{ question:'能否只根據 `requirement` 寫出一個測試：一組明確輸入與一個預期輸出？' },
  criteria:{ true:'寫明輸入或情境，以及單一預期結果',
             false:'缺輸入、缺預期結果，或需要多個斷言' } }
```
- 組合：`HIGH = 0.65`、`LOW = 0.35`。單題 ≥HIGH 通過、≤LOW 不通過、中間不確定。單條：任一不通過 → `fail`；否則任一不確定 → `unsure`；否則 `pass`。初期只當提示，不擋確認。
- 失敗退路：無 key、逾時、非 2xx、壞 JSON → 只跑第 2 層，`layer3.status` 記原因，回應註明「第 3 層未執行：<原因>」，照樣寫檔。不記錄 headers／key。

## 輪數與提問（全部記在 checks，不放記憶體）
- agentKey：`tool.call` 的 `e.agentId`，主 session 用 `main`。
- 同一 agentKey 再次送出 → `round + 1`。round 1 = 初稿，2、3 = 自動重寫；round 3 寫檔後回應「已達重寫上限：停止修改，回報 spec_id 與未通過條目」；round ≥ 4 → 拒絕、不寫檔。
- 換了 agentKey（主 session 帶使用者答案重派 planner）→ `revision + 1`、`round = 1`。revision 上限 3：達上限時回應「不再提問，剩下的問題留在 open_questions，直接交 confirm」。
- 「全部通過」= 每個 fail/unsure 條目不是已修正，就是已列入 open_questions。

## 寫法問題 vs 需求問題（planner 判準）
- **寫法問題** → planner 自己重寫：修正所需資訊已在簡報或程式碼中（含「且」且兩半都已寫明 → 拆兩條；缺檔名但查得到 → 補；指代對象明確 → 換實名；test 條目缺輸入／預期但簡報有 → 補；過長 → 拆）。需查證的事實由 planner 自己查。
- **需求問題** → 寫進 `open_questions`、保留原條目：修正需要一個簡報與程式碼都沒有答案的決定（數值、邊界行為、兩種解讀擇一、是否納入範圍）。

## SPEC_TAIL（附加在名稱含 grill／plan 的 skill 後，每回合一次；主 session 的收尾流程）
在 grilling frontier 清空、使用者確認已有共識之後：
1. 問使用者是否產出拆題檔（選項：產出（Recommended）／不用）。grilling 也用於非程式碼討論，選「不用」即結束。
2. 寫需求簡報：本意、限制與決定（附使用者原話）、已知檔案、不做的事。完成條件：每條限制都對應到對話出處，簡報脫離對話也讀得懂。
3. 派 `system1:planner`，prompt 為簡報全文（重派時附 spec_id）。完成條件：planner 回報 spec_id。
4. 若有 open_questions：依本 session 的 grilling 提問方式問使用者，答案併入簡報，回到第 3 步（帶同一 spec_id）。
5. 依 hook 附上的摘要列出全部條目（待問題目 → fail → unsure → 第 2 層標記 → 其餘），呼叫 `mcp__system1__confirm_plan`。回報規格路徑；實作從使用者下一個指令開始。
提問格式不在 SPEC_TAIL 重述，只寫「依本 session 的 grilling 提問方式」（grill-choices 開著時自然沿用其 AskUserQuestion 格式）。

## 共用型別與函式簽名（`system1/hooks/plan.ts`，U1 實作、U2 引用）
```ts
export const HIGH = 0.65, LOW = 0.35, MAX_ITEMS = 30
export type VerifyBy = 'test' | 'jev' | 'agent'
export interface Requirement { id: string; text: string; verify_by: VerifyBy }
export interface OpenQuestion { req_id: string; question: string; options: string[]; recommended: number; why: string }
export type Verdict = 'pass' | 'fail' | 'unsure'
export interface ItemAnswer { single_condition: number; self_contained: number; testable?: number }
export interface Layer3 { status: 'ok' | 'skipped:no-key' | 'timeout' | 'partial-timeout' | 'error'; items: Record<string, ItemAnswer & { verdict: Verdict }> }
export interface Checks { round: number; revision: number; agent: string; layer2: Record<string, string[]>; layer3: Layer3 }
export interface Spec { schema: 1; id: string; status: 'draft' | 'confirmed' | 'superseded'; created_at: string; confirmed_at?: string; base_commit?: string; intent: string; requirements: Requirement[]; out_of_scope: string[]; open_questions: OpenQuestion[]; checks: Checks }
export interface SpecInput { spec_id?: string; slug: string; intent: string; requirements: Requirement[]; out_of_scope: string[]; open_questions?: OpenQuestion[] }

export function validateSpec(input: unknown): { ok: true; value: SpecInput } | { ok: false; errors: string[] }
export function flagSuspicious(text: string): string[]
export function buildItemRequest(req: Requirement): { model: 'jev-latest'; state: { requirement: string; verify_by: VerifyBy }; questions: Record<string, unknown> }
export function parseItemAnswer(text: string, verifyBy: VerifyBy): ItemAnswer | null
export function judgeItem(a: ItemAnswer): Verdict
export function roundState(prev: Checks | undefined, agentKey: string): { round: number; revision: number; decision: 'write' | 'write-final' | 'reject'; askAllowed: boolean }
export function formatReport(spec: Spec, state: { decision: 'write' | 'write-final'; askAllowed: boolean }): string
export function pickActiveSpec(files: { name: string; text: string }[]): Spec | null
export function makeSpecId(now: Date, slug: string, existing: Set<string>): string
export function isGuardedSpecPath(realPath: string, toplevel: string): boolean
```
- `roundState`：prev 為 undefined → `{round:1, revision:1}`；`prev.agent === agentKey` → round+1（round 3 → `write-final`，≥4 → `reject`）；否則 revision+1、round 1。`askAllowed = revision < 3`。
- `formatReport`：順序 待問題目 → fail → unsure → 第 2 層標記；附「剩餘自動重寫 N 輪」、revision，及 decision／askAllowed 對應的指示句。
- `isGuardedSpecPath`：僅 `<toplevel>/context/specs/<name>.json`（第一層、無 `..`）為真。

## 提示文字（U3）
- `system1/agents/planner.md`（或由 register.ts 以 `$.agent.register` 註冊時引用的常數）與 `system1/hooks/prompts.ts` 匯出 `SPEC_TAIL`、`PLANNER_PROMPT`。撰寫前載入 writing-for-agents。

## Review 後的補強（2026-10-13）
- planner 一律前景執行（`agent.spawn` → `background: false`）；planner 回報時逐字轉述結束關鍵字與報告摘要，主 session 不依賴 hook 也能判斷。
- 寫入防護：specs 資料夾不存在時，以最近存在的祖先目錄 realPath 推算落點；`context/specs` 前綴不分大小寫。
- 不信任檔案內容的 id：寫入路徑用已驗證的 spec_id；parseSpec 要求 id 符合格式且等於檔名。
- confirm_plan 在使用者回答後重讀檔案，期間有新版本送出就不確認。
- revision 硬上限：revision ≥ 4 → 拒絕（訊息含「不再提問」）；round ≥ 4 拒絕訊息含「已達重寫上限」。
- 使用者中斷後不寫檔；validateSpec 只保留已知欄位。
- 「全部通過」只看已判定的條目（第 3 層未完整時報告另有一行說明）：刻意設計，第 2 層標記只作為給使用者看的提示。
