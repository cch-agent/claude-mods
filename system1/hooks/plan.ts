// 第 2 階段：grilling 收尾拆題 → 規格檔。本檔全為純函式，不依賴 `$`，方便單元測試。

export const HIGH = 0.65,
  LOW = 0.35,
  MAX_ITEMS = 30
export type VerifyBy = 'test' | 'jev' | 'agent'
export interface Requirement { id: string; text: string; verify_by: VerifyBy }
export interface OpenQuestion { req_id: string; question: string; options: string[]; recommended: number; why: string }
export type Verdict = 'pass' | 'fail' | 'unsure'
export interface ItemAnswer { single_condition: number; self_contained: number; testable?: number }
export interface Layer3 { status: 'ok' | 'skipped:no-key' | 'timeout' | 'partial-timeout' | 'error'; items: Record<string, ItemAnswer & { verdict: Verdict }> }
export interface Checks { round: number; revision: number; agent: string; layer2: Record<string, string[]>; layer3: Layer3 }
export interface Spec { schema: 1; id: string; status: 'draft' | 'confirmed' | 'superseded'; created_at: string; confirmed_at?: string; base_commit?: string; intent: string; requirements: Requirement[]; out_of_scope: string[]; open_questions: OpenQuestion[]; checks: Checks }
export interface SpecInput { spec_id?: string; slug: string; intent: string; requirements: Requirement[]; out_of_scope: string[]; open_questions?: OpenQuestion[] }

const VERIFY_BY = ['test', 'jev', 'agent']
const REQ_ID = /^R\d+[a-z]?$/
const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 驗證 planner 送來的規格輸入；回傳所有錯誤而非只第一個。 */
export function validateSpec(input: unknown): { ok: true; value: SpecInput } | { ok: false; errors: string[] } {
  if (!isObj(input)) return { ok: false, errors: ['輸入必須是物件'] }
  const errors: string[] = []

  if (!isStr(input.intent) || !input.intent.trim()) errors.push('缺少 intent（一句話本意）')

  const ids = new Set<string>()
  const reqs: Requirement[] = []
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
    errors.push('requirements 不可為空')
  } else {
    for (const [i, r] of input.requirements.entries()) {
      if (!isObj(r)) {
        errors.push(`requirements[${i}] 必須是物件`)
        continue
      }
      const label = isStr(r.id) ? r.id : `#${i}`
      if (!isStr(r.id) || !REQ_ID.test(r.id)) errors.push(`${label}：id 須符合 ^R\\d+[a-z]?$`)
      else if (ids.has(r.id)) errors.push(`${label}：id 重複`)
      else ids.add(r.id)
      if (!isStr(r.text) || !r.text.trim()) errors.push(`${label}：text 不可為空`)
      if (!isStr(r.verify_by) || !VERIFY_BY.includes(r.verify_by)) errors.push(`${label}：verify_by 須為 test／jev／agent`)
      reqs.push({ id: r.id as string, text: r.text as string, verify_by: r.verify_by as VerifyBy }) // 只留三個欄位
    }
  }

  if (!Array.isArray(input.out_of_scope) || !input.out_of_scope.every(isStr)) errors.push('out_of_scope 須為字串陣列')

  const oqs: OpenQuestion[] = []
  if (input.open_questions !== undefined) {
    if (!Array.isArray(input.open_questions)) errors.push('open_questions 須為陣列')
    else {
      for (const [i, q] of input.open_questions.entries()) {
        const label = `open_questions[${i}]`
        if (!isObj(q)) {
          errors.push(`${label} 必須是物件`)
          continue
        }
        if (!isStr(q.req_id) || !ids.has(q.req_id)) errors.push(`${label}：req_id 必須是存在的需求 id`)
        if (!isStr(q.question) || !q.question.trim()) errors.push(`${label}：question 不可為空`)
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4 || !q.options.every(isStr)) {
          errors.push(`${label}：options 須為 2–4 個字串`)
        } else if (!Number.isInteger(q.recommended) || (q.recommended as number) < 0 || (q.recommended as number) >= q.options.length) {
          errors.push(`${label}：recommended 須為 options 的有效索引`)
        }
        if (!isStr(q.why)) errors.push(`${label}：why 須為字串`)
        oqs.push({ req_id: q.req_id as string, question: q.question as string, options: q.options as string[], recommended: q.recommended as number, why: q.why as string })
      }
    }
  }

  if (input.spec_id !== undefined && !isStr(input.spec_id)) errors.push('spec_id 須為字串')
  if (input.slug !== undefined && !isStr(input.slug)) errors.push('slug 須為字串')

  if (errors.length) return { ok: false, errors }
  const value: SpecInput = {
    slug: isStr(input.slug) ? input.slug : '',
    intent: input.intent as string,
    requirements: reqs,
    out_of_scope: input.out_of_scope as string[],
    open_questions: oqs,
  }
  if (isStr(input.spec_id)) value.spec_id = input.spec_id
  return { ok: true, value }
}

/** 第 2 層：只標記可疑處，不判對錯。 */
export function flagSuspicious(text: string): string[] {
  const flags: string[] = []
  // 較長的詞先比對並從工作字串移除，避免「並且」同時被標成「並」「且」
  let rest = text
  for (const w of ['並且', '以及', '同時', '並', '且']) {
    if (rest.includes(w)) {
      flags.push(`conjunction:${w}`)
      rest = rest.split(w).join(' ')
    }
  }
  if (/,\s*and\b/i.test(text)) flags.push('conjunction:, and')
  for (const w of ['剛才', '上述', '前述', '這個', '那個']) if (text.includes(w)) flags.push(`pronoun:${w}`)
  if (/(?<!應)該/.test(text)) flags.push('pronoun:該') // 排除「應該」
  if (/\babove\b/i.test(text)) flags.push('pronoun:above')
  const len = Array.from(text).length
  if (len > 80) flags.push(`long:${len}`)
  return flags
}

/** 第 3 層：每條需求一個請求，state 只含該條。testable 只在 verify_by === 'test' 時問。 */
export function buildItemRequest(req: Requirement): { model: 'jev-latest'; state: { requirement: string; verify_by: VerifyBy }; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {
    single_condition: {
      type: 'noul',
      instructions: { question: '`requirement` 是否只描述一個可獨立判斷是否滿足的條件？' },
      criteria: {
        true: '只有一個條件，一次檢查即可判定',
        false: '含兩個以上可分開判斷的條件，例如以「且／並／以及」連接，或同時規定行為與修改範圍',
      },
    },
    self_contained: {
      type: 'noul',
      instructions: { question: '只讀 `requirement` 這一句、不看任何其他資料，能否判斷一段程式變更是否滿足它？' },
      criteria: {
        true: '寫明具體對象（檔名、函式、數值或行為），可直接比對',
        false: '需要句外脈絡才知道指什麼（如「剛才、上述、這個」），或描述模糊到無法判定',
      },
    },
  }
  if (req.verify_by === 'test') {
    questions.testable = {
      type: 'noul',
      instructions: { question: '能否只根據 `requirement` 寫出一個測試：一組明確輸入與一個預期輸出？' },
      criteria: {
        true: '寫明輸入或情境，以及單一預期結果',
        false: '缺輸入、缺預期結果，或需要多個斷言',
      },
    }
  }
  return { model: 'jev-latest', state: { requirement: req.text, verify_by: req.verify_by }, questions }
}

/** 解析 API 回應；缺欄位、非數字或超出 [0,1] 回 null。 */
export function parseItemAnswer(text: string, verifyBy: VerifyBy): ItemAnswer | null {
  try {
    const answers = (JSON.parse(text) as { answers?: Record<string, { noul?: unknown }> } | null)?.answers
    if (!answers || typeof answers !== 'object') return null
    const get = (id: string): number | null => {
      const v = answers[id]?.noul
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
    }
    const single = get('single_condition')
    const self = get('self_contained')
    if (single === null || self === null) return null
    const out: ItemAnswer = { single_condition: single, self_contained: self }
    if (verifyBy === 'test') {
      const t = get('testable')
      if (t === null) return null
      out.testable = t
    }
    return out
  } catch {
    return null
  }
}

/** 任一題 ≤LOW → fail；否則任一題落在不確定帶 → unsure；否則 pass。 */
export function judgeItem(a: ItemAnswer): Verdict {
  const vs = [a.single_condition, a.self_contained]
  if (a.testable !== undefined) vs.push(a.testable)
  if (vs.some(v => v <= LOW)) return 'fail'
  if (vs.some(v => v < HIGH)) return 'unsure'
  return 'pass'
}

/** 輪數：同一 agent 再送 → round+1；換 agent → revision+1、round 重算。 */
export function roundState(prev: Checks | undefined, agentKey: string): { round: number; revision: number; decision: 'write' | 'write-final' | 'reject'; askAllowed: boolean } {
  let round = 1
  let revision = 1
  if (prev) {
    if (prev.agent === agentKey) {
      round = prev.round + 1
      revision = prev.revision
    } else {
      revision = prev.revision + 1
    }
  }
  // round 超過 3，或 revision 超過硬上限 3（換 agent 後變 4 以上）一律拒絕
  const decision = round >= 4 || revision >= 4 ? 'reject' : round === 3 ? 'write-final' : 'write'
  return { round, revision, decision, askAllowed: revision < 3 }
}

/** 回給 planner／主 session 的報告：待問題目 → fail → unsure → 第 2 層標記，最後附指示句。 */
export function formatReport(spec: Spec, state: { decision: 'write' | 'write-final'; askAllowed: boolean }): string {
  const { checks } = spec
  const text = new Map(spec.requirements.map(r => [r.id, r.text]))
  const lines: string[] = [
    `規格 ${spec.id}（第 ${checks.round} 輪，revision ${checks.revision}，共 ${spec.requirements.length} 條）`,
  ]

  if (spec.open_questions.length) {
    lines.push('', '待問題目：')
    for (const q of spec.open_questions) {
      lines.push(`- ${q.req_id}：${q.question}（選項：${q.options.join(' / ')}；建議：${q.options[q.recommended]}；理由：${q.why}）`)
    }
  }
  const items = checks.layer3.items
  for (const [verdict, title] of [['fail', '未通過（fail）'], ['unsure', '不確定（unsure）']] as const) {
    const ids = Object.keys(items).filter(id => items[id]!.verdict === verdict)
    if (!ids.length) continue
    lines.push('', `${title}：`)
    for (const id of ids) {
      const a = items[id]!
      const scores = [`single=${a.single_condition}`, `self=${a.self_contained}`, ...(a.testable !== undefined ? [`testable=${a.testable}`] : [])]
      lines.push(`- ${id}（${scores.join(', ')}）${text.get(id) ?? ''}`)
    }
  }
  const flagged = Object.keys(checks.layer2).filter(id => checks.layer2[id]!.length)
  if (flagged.length) {
    lines.push('', '第 2 層標記：')
    for (const id of flagged) lines.push(`- ${id}：${checks.layer2[id]!.join('、')}`)
  }

  const s = checks.layer3.status
  if (s === 'partial-timeout') lines.push('', '第 3 層部分逾時：未回來的條目只有第 2 層結果')
  else if (s !== 'ok') lines.push('', `第 3 層未執行：${s}`)

  lines.push('', `剩餘自動重寫 ${Math.max(0, 3 - checks.round)} 輪；revision ${checks.revision}/3`)
  // 刻意設計：「全部通過」只看已判定的條目；第 3 層未完整時（未執行／部分逾時）報告另有專行說明，不在此排除
  // 每個 fail/unsure 條目都已列入 open_questions 時，宣告全部通過（planner 據此結束）
  const asked = new Set(spec.open_questions.map(q => q.req_id))
  if (Object.entries(items).every(([id, a]) => a.verdict === 'pass' || asked.has(id))) lines.push('全部通過：沒有待重寫的條目')
  if (state.decision === 'write-final') lines.push('已達重寫上限：停止修改，回報 spec_id 與未通過條目')
  else lines.push('寫法問題自行重寫後帶 spec_id 再送出；需求問題列入 open_questions 並保留原條目')
  if (!state.askAllowed) lines.push('不再提問，剩下的問題留在 open_questions，直接交 confirm')
  return lines.join('\n')
}

/** 目前生效的規格：status 為 confirmed 中 confirmed_at 最新者，同時間取 id 字典序較大者。 */
export function pickActiveSpec(files: { name: string; text: string }[]): Spec | null {
  let best: Spec | null = null
  for (const f of files) {
    let spec: Spec
    try {
      spec = JSON.parse(f.text) as Spec
    } catch {
      continue
    }
    if (!isObj(spec) || spec.schema !== 1 || spec.status !== 'confirmed') continue
    if (!best) {
      best = spec
      continue
    }
    const a = spec.confirmed_at ?? ''
    const b = best.confirmed_at ?? ''
    if (a > b || (a === b && String(spec.id) > String(best.id))) best = spec
  }
  return best
}

/** `YYYYMMDD-HHMM-<slug>`（UTC）；slug 清理為 [a-z0-9-]，撞名加 -2、-3。 */
export function makeSpecId(now: Date, slug: string, existing: Set<string>): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'spec'
  const base = `${stamp}-${clean}`
  if (!existing.has(base)) return base
  for (let n = 2; ; n++) if (!existing.has(`${base}-${n}`)) return `${base}-${n}`
}

/** 僅 `<toplevel>/context/specs/<name>.json`（第一層、無 `..`）為真。 */
export function isGuardedSpecPath(realPath: string, toplevel: string): boolean {
  // macOS 預設不分大小寫，`Context/Specs/x.json` 指向同一檔，故前綴不分大小寫比對
  const prefix = `${toplevel.replace(/\/+$/, '')}/context/specs/`.toLowerCase()
  if (realPath.split('/').includes('..') || !realPath.toLowerCase().startsWith(prefix)) return false
  const rest = realPath.slice(prefix.length)
  if (rest.includes('/') || rest.includes('..')) return false
  return rest.endsWith('.json') && rest.length > '.json'.length
}
