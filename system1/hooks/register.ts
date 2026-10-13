import type { Register } from 'claude-code'

import {
  MAX_ITEMS,
  buildItemRequest,
  flagSuspicious,
  formatReport,
  isGuardedSpecPath,
  judgeItem,
  makeSpecId,
  parseItemAnswer,
  roundState,
  validateSpec,
  type Checks,
  type Layer3,
  type Spec,
} from './plan'
import { PLANNER_PROMPT, SPEC_TAIL } from './prompts'

export type Model = 'opus' | 'sonnet' | 'haiku'
export type QuestionId =
  | 'needs_architecture'
  | 'needs_deep_reasoning'
  | 'design_settled'
  | 'modifies_code'
  | 'lookup_or_chore'
export type Nouls = Record<QuestionId, number>

export const HIGH = 0.65
export const LOW = 0.35
export const API_URL = 'https://api.typesafe.ai/v1/systemone'
export const TIMEOUT_MS = 3000
export const PROMPT_LIMIT = 6000

const QUESTION_TEXT: Record<QuestionId, string> = {
  needs_architecture: '任務是否需要做架構設計，或在多個方案間做取捨決策？',
  needs_deep_reasoning: '任務是否需要深度分析或多步推理才能完成？',
  design_settled: '做法是否已定案，只需照著既定規格執行？',
  modifies_code: '任務是否需要撰寫或修改程式碼、測試，或審查程式碼？',
  lookup_or_chore: '任務是否只是查找資料、搜尋檔案、格式化輸出或重複性操作？',
}
const IDS = Object.keys(QUESTION_TEXT) as QuestionId[]

const uncertain = (v: number) => v > LOW && v < HIGH

/** 五題 Noul 答案 → model；null 代表不覆寫。判斷順序內只檢查該分支用到的題目是否落在不確定帶 (0.35, 0.65)。 */
export function decideModel(n: Nouls): Model | null {
  // opus 分支：max(needs_architecture, needs_deep_reasoning) 與 design_settled
  const arch = Math.max(n.needs_architecture, n.needs_deep_reasoning)
  if (uncertain(arch)) return null
  if (arch >= HIGH) {
    if (uncertain(n.design_settled)) return null
    if (n.design_settled < HIGH) return 'opus'
  }
  // haiku 分支：lookup_or_chore 與 modifies_code
  if (uncertain(n.lookup_or_chore)) return null
  if (n.lookup_or_chore >= HIGH) {
    if (uncertain(n.modifies_code)) return null
    if (n.modifies_code <= LOW) return 'haiku'
  }
  // sonnet 分支：modifies_code 或 design_settled 明確為是
  if (n.modifies_code >= HIGH || n.design_settled >= HIGH) return 'sonnet'
  return null
}

export function buildRequest(description: string, prompt: string) {
  const questions: Record<string, unknown> = {}
  for (const id of IDS) {
    questions[id] = {
      type: 'noul',
      instructions: { task: '`prompt`', question: QUESTION_TEXT[id] },
    }
  }
  return {
    model: 'jev-latest',
    state: { description, prompt: prompt.slice(0, PROMPT_LIMIT) },
    questions,
  }
}

/** 解析 API 回應；任何欄位缺漏或格式不對回 null。 */
export function parseNouls(text: string): Nouls | null {
  try {
    const answers = (JSON.parse(text) as { answers?: Record<string, { noul?: unknown }> }).answers
    if (!answers || typeof answers !== 'object') return null
    const out = {} as Nouls
    for (const id of IDS) {
      const v = answers[id]?.noul
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null
      out[id] = v
    }
    return out
  } catch {
    return null
  }
}

export function statusText(chosen: Model | null, original: string | undefined): string {
  if (chosen === null) return `保留 ${original ?? '未指定'}`
  return `${chosen}` + (chosen !== original ? `（原 ${original ?? '未指定'}）` : '')
}


const SUBMIT = 'mcp__system1__submit_plan'
const CONFIRM = 'mcp__system1__confirm_plan'
export const LAYER3_CONCURRENCY = 4
export const LAYER3_TIMEOUT_MS = 8000
const GUARDED_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const

// skill 名稱（含 plugin 前綴）含 grill 或 plan 即視為需要收尾拆題的規格類 skill，不分大小寫
export const isSpecSkill = (skill: string) => /grill|plan/i.test(skill)

const SUBMIT_SCHEMA = {
  type: 'object',
  properties: {
    spec_id: { type: 'string', description: '修改既有規格時帶上；第一次送出不要帶' },
    slug: { type: 'string', description: '英數與連字號的短名稱，用於組成 spec id' },
    intent: { type: 'string', description: '一句話本意' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'R1、R2…（可加一個小寫字母後綴）' },
          text: { type: 'string' },
          verify_by: { type: 'string', enum: ['test', 'jev', 'agent'] },
        },
        required: ['id', 'text', 'verify_by'],
      },
    },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    open_questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          req_id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommended: { type: 'integer' },
          why: { type: 'string' },
        },
        required: ['req_id', 'question', 'options', 'recommended', 'why'],
      },
    },
  },
  required: ['slug', 'intent', 'requirements', 'out_of_scope'],
}

const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { spec_id: { type: 'string', description: '要確認的規格 id' } },
  required: ['spec_id'],
}

const SPEC_ID_RE = /^[A-Za-z0-9-]+$/

/** 不信任檔案內容的 id：必須合法且等於檔名（去 .json），否則視為無效。 */
const parseSpec = (text: string, fileId: string): Spec | null => {
  try {
    const s = JSON.parse(text) as Spec
    return s && s.schema === 1 && typeof s.id === 'string' && SPEC_ID_RE.test(s.id) && s.id === fileId ? s : null
  } catch {
    return null
  }
}

type State = { root: Promise<string> | undefined; written: { seq: number; id: string; report: string } }
const getRoot = ($: any, st: State): Promise<string> =>
  (st.root ??= (async () => {
    try {
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
      const top = String(r.stdout ?? '').trim()
      if (r.exitCode === 0 && top) return top
    } catch {
      // 退回 cwd
    }
    return $.session.cwd()
  })())

const specsDir = (root: string) => `${root}/context/specs`

const listSpecFiles = async ($: any, root: string) => {
  const dir = specsDir(root)
  let entries: { name: string; kind: string }[]
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const out: { name: string; text: string }[] = []
  for (const en of entries) {
    if (en.kind !== 'file' || !en.name.endsWith('.json')) continue
    try {
      out.push({ name: en.name, text: (await $.fs.read(`${dir}/${en.name}`)) as string })
    } catch {
      // 讀不到的略過
    }
  }
  return out
}

const readSpec = async ($: any, root: string, id: string): Promise<Spec | null> => {
  try {
    return parseSpec((await $.fs.read(`${specsDir(root)}/${id}.json`)) as string, id)
  } catch {
    return null
  }
}

const writeSpec = ($: any, root: string, id: string, spec: Spec) =>
  $.fs.write(`${specsDir(root)}/${id}.json`, JSON.stringify({ ...spec, id }, null, 2) + '\n') as Promise<void>

/** 第 3 層：每條一個請求，併發 4、總逾時 8 秒；失敗只降級，不拋錯。 */
const runLayer3 = async ($: any, key: string | undefined, reqs: Spec['requirements'], signal: AbortSignal): Promise<Layer3> => {
  if (!key) return { status: 'skipped:no-key', items: {} }
  const sent = reqs.slice(0, MAX_ITEMS)
  const items: Layer3['items'] = {}
  let errors = 0
  let stopped = false
  let cursor = 0
  const worker = async () => {
    while (!stopped && cursor < sent.length) {
      const req = sent[cursor++]!
      try {
        const r = await $.http.fetch(API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildItemRequest(req)),
        })
        const a = r.ok ? parseItemAnswer(r.text, req.verify_by) : null
        if (stopped) return
        if (a) items[req.id] = { ...a, verdict: judgeItem(a) }
        else errors++
      } catch {
        if (!stopped) errors++ // 不記錄 headers／key
      }
    }
  }
  const abort = new AbortController()
  const onStop = () => abort.abort()
  if (signal.aborted) onStop()
  else signal.addEventListener('abort', onStop)
  try {
    const all = Promise.all(Array.from({ length: Math.min(LAYER3_CONCURRENCY, sent.length) }, worker)).then(() => true)
    const timeout = $.clock.sleep(LAYER3_TIMEOUT_MS, { signal: abort.signal }).then(
      () => false,
      () => false,
    )
    const finished = await Promise.race([all, timeout])
    all.catch(() => {})
    stopped = true
    const got = Object.keys(items).length
    const timedOut = !finished
    if (got === sent.length) return { status: 'ok', items }
    if (timedOut) return { status: got === 0 ? 'timeout' : 'partial-timeout', items }
    return { status: 'error', items }
  } finally {
    stopped = true
    abort.abort()
    signal.removeEventListener('abort', onStop)
  }
}


// 路徑落點：往上找第一個存在的祖先取 realPath，再接上不存在的剩餘段。
// 剩餘段含 `..` 時回 'unsafe'（無法判斷落點，呼叫端視為受保護）；無法解析回 undefined。
const placed = async ($: any, path: string): Promise<string | 'unsafe' | undefined> => {
  const abs = path.startsWith('/') ? path : `${(await $.session.cwd()).replace(/\/$/, '')}/${path}`
  const segs = abs.split('/').filter((x: string) => x !== '' && x !== '.')
  const rest: string[] = []
  while (true) {
    const cur = '/' + segs.join('/')
    const st = await $.fs.stat(cur, { resolve: true }).catch(() => undefined)
    if (st?.realPath) {
      if (rest.includes('..')) return 'unsafe'
      const base = (st.realPath as string).replace(/\/$/, '')
      return rest.length ? `${base}/${rest.join('/')}` : base
    }
    if (segs.length === 0) return undefined
    rest.unshift(segs.pop()!)
  }
}


export const register: Register = on => {
  const state: State = { root: undefined, written: { seq: 0, id: '', report: '' } }

  const textResult = (text: string) => ({ result: text })

  on('session.start', async ($, e, next) => {
    // 三個註冊各自獨立，一個失敗不連帶其他
    try {
      await $.tool.register({
        name: 'submit_plan',
        description:
          '送出需求拆題後的規格（唯一寫入路徑）：檢查格式與條目品質、寫入 context/specs/<id>.json，回傳檢查報告。只給 system1:planner 使用。',
        inputSchema: SUBMIT_SCHEMA,
        isDeferred: false,
      })
    } catch {
      // 略過
    }
    try {
      await $.tool.register({
        name: 'confirm_plan',
        description: '請使用者確認規格（spec_id）。確認後該規格才生效；只在拆題流程最後由主 session 呼叫。',
        inputSchema: CONFIRM_SCHEMA,
        isDeferred: false,
      })
    } catch {
      // 略過
    }
    try {
      await $.agent.register({
        name: 'planner',
        description: '把需求簡報拆成原子、可驗證的規格條目並送出檢查（grilling 收尾拆題時使用，傳入需求簡報全文）。',
        prompt: PLANNER_PROMPT,
        tools: ['Read', 'Bash', SUBMIT],
        model: 'opus',
        maxTurns: 40,
      })
    } catch {
      // 略過
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // planner 必須在前景跑，Agent 工具才會等到它結束，hook 才附得上摘要
  on('agent.spawn', ($, e, next) => (e.subagentType === 'system1:planner' ? next({ ...e, background: false }) : next(e))).catch(
    ($, e, next) => next(e),
  )

  on('tool.call', { tool: SUBMIT }, async ($, e: any, next) => {
    const input = {
      spec_id: e.spec_id,
      slug: e.slug,
      intent: e.intent,
      requirements: e.requirements,
      out_of_scope: e.out_of_scope,
      open_questions: e.open_questions,
    }
    const v = validateSpec(input)
    if (!v.ok) return textResult(`格式錯誤，未寫入：\n${v.errors.map(x => `- ${x}`).join('\n')}\n請修正後重送。`)
    const root = await getRoot($, state)
    const files = await listSpecFiles($, root)
    const existing = new Set(files.map(f => f.name.replace(/\.json$/, '')))

    let prev: Spec | null = null
    let id: string
    if (v.value.spec_id !== undefined) {
      if (!SPEC_ID_RE.test(v.value.spec_id)) return textResult('spec_id 格式不符，未寫入。')
      prev = await readSpec($, root, v.value.spec_id)
      if (!prev) return textResult(`找不到 spec_id ${v.value.spec_id}，未寫入。第一次送出請不要帶 spec_id。`)
      id = v.value.spec_id
    } else {
      id = makeSpecId(new Date(await $.clock.now()), v.value.slug, existing)
    }

    const agentKey: string = e.agentId ?? 'main'
    const st = roundState(prev?.checks, agentKey)
    if (st.decision === 'reject') {
      const stop = !st.askAllowed || st.revision >= 4 ? '不再提問；' : ''
      return textResult(`規格 ${id} 已達重寫上限（第 ${st.round} 輪、revision ${st.revision}），拒絕修改、未寫入。${stop}請回報 spec_id 與未通過條目。`)
    }

    const layer2: Record<string, string[]> = {}
    for (const r of v.value.requirements) layer2[r.id] = flagSuspicious(r.text)
    const key = (await $.env.get('TYPESAFE_API_KEY')) as string | undefined
    const layer3 = await runLayer3($, key, v.value.requirements, next.signal)
    const checks: Checks = { round: st.round, revision: st.revision, agent: agentKey, layer2, layer3 }

    // 狀態、時間、base_commit、checks 一律由 mod 決定；修改過的規格（含 confirmed）回到 draft
    const spec: Spec = {
      schema: 1,
      id,
      status: 'draft',
      created_at: prev?.created_at ?? new Date(await $.clock.now()).toISOString(),
      intent: v.value.intent,
      requirements: v.value.requirements,
      out_of_scope: v.value.out_of_scope,
      open_questions: v.value.open_questions ?? [],
      checks,
    }
    if (next.signal.aborted) return textResult('呼叫已中斷，未寫入。')
    await writeSpec($, root, id, spec)
    const report = formatReport(spec, { decision: st.decision, askAllowed: st.askAllowed })
    state.written = { seq: state.written.seq + 1, id, report }
    const note = v.value.requirements.length > MAX_ITEMS ? `\n註：超過 ${MAX_ITEMS} 條，後面的條目未送第 3 層檢查。` : ''
    return textResult(report + note)
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'submit_plan 內部錯誤，未寫入。' }))

  on('tool.call', { tool: CONFIRM }, async ($, e: any, next) => {
    const id = String(e.spec_id ?? '')
    if (!SPEC_ID_RE.test(id)) return textResult('spec_id 格式不符。')
    const root = await getRoot($, state)
    const spec = await readSpec($, root, id)
    if (!spec) return textResult(`找不到規格 ${id}。`)
    if (spec.status === 'confirmed') return textResult(`規格 ${id} 已是 confirmed。`)

    const flagged = spec.requirements.filter(
      r => (spec.checks.layer2[r.id]?.length ?? 0) > 0 || (spec.checks.layer3.items[r.id] && spec.checks.layer3.items[r.id]!.verdict !== 'pass'),
    ).length
    const q = `規格 ${id}：共 ${spec.requirements.length} 條，${flagged} 條有標記，${spec.open_questions.length} 個未解問題，是否確認？`
    const before = spec.checks
    let ans: string
    try {
      ans = await $.ui.ask(q, ['確認', '修改', '取消'])
    } catch {
      return textResult(`無法詢問使用者（非互動模式或已關閉），規格 ${id} 維持 draft。`)
    }
    if (ans === '取消') return textResult(`使用者取消，規格 ${id} 維持 draft。`)
    if (ans !== '確認') {
      const extra = ans === '修改' ? '' : `：${ans}`
      return textResult(`使用者要求修改${extra}。規格 ${id} 維持 draft，請依意見調整後帶 spec_id 重派 planner。`)
    }

    // 詢問期間規格可能被改寫：重讀，輪數／revision／agent 有變就不確認
    const fresh = await readSpec($, root, id)
    if (!fresh || fresh.checks.round !== before.round || fresh.checks.revision !== before.revision || fresh.checks.agent !== before.agent) {
      return textResult(`規格 ${id} 已更新，請重新確認。`)
    }
    if (next.signal.aborted) return textResult('呼叫已中斷，規格狀態未變。')
    let base: string | undefined
    try {
      const r = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd: root })
      if (r.exitCode === 0 && r.stdout.trim()) base = r.stdout.trim()
    } catch {
      // 無 git 時不記 base_commit
    }
    const confirmed: Spec = {
      ...spec,
      status: 'confirmed',
      confirmed_at: new Date(await $.clock.now()).toISOString(),
      ...(base ? { base_commit: base } : {}),
    }
    await writeSpec($, root, id, confirmed)
    // 盡力把其他 confirmed 標成 superseded；生效規則不依賴它
    for (const f of await listSpecFiles($, root)) {
      const fileId = f.name.replace(/\.json$/, '')
      const other = parseSpec(f.text, fileId)
      if (!other || fileId === id || other.status !== 'confirmed') continue
      try {
        await writeSpec($, root, fileId, { ...other, status: 'superseded' })
      } catch {
        // 略過
      }
    }
    return textResult(`已確認規格 ${id}\n路徑：${specsDir(root)}/${id}.json\nbase_commit：${base ?? '（無）'}\n實作從使用者下一個指令開始。`)
  }).catch(($, e, next) => (next.called ? next(e) : { result: 'confirm_plan 內部錯誤，規格狀態未變。' }))

  // 寫入防護：規格檔只能經 submit_plan 修改
  for (const tool of GUARDED_TOOLS) {
    on('tool.call', { tool: tool as 'Write' }, async ($, e: any, next) => {
      const path: unknown = e.file_path ?? e.notebook_path
      if (typeof path !== 'string' || !path) return next(e)
      const root = await getRoot($, state)
      const real = await placed($, path)
      if (!real) return next(e)
      const DENY = { deny: '規格檔只能經 mcp__system1__submit_plan（帶 spec_id）修改；修改後需重新確認' }
      if (real === 'unsafe') return DENY // 不存在的路徑段含 `..`，落點無法判斷
      const top = (await $.fs.stat(root, { resolve: true }).catch(() => undefined))?.realPath ?? root
      // 比對不分大小寫（macOS 預設大小寫不敏感）
      const lower = real.toLowerCase()
      if (isGuardedSpecPath(lower, top.toLowerCase()) || isGuardedSpecPath(lower, root.toLowerCase())) return DENY
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  // 同一回合只附加一次（grill-with-docs 會再載入 grilling，兩者都命中）。
  // 旗標存在閉包內；熱重載會重設為 false，最多多附加一次，可接受。
  let appendedThisTurn = false
  on('prompt.submit', ($, e, next) => {
    appendedThisTurn = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', ($, e, next) => {
    if (isSpecSkill(e.skill) && !appendedThisTurn && !e.text.includes(SPEC_TAIL)) {
      appendedThisTurn = true
      return next({ ...e, text: e.text + (SPEC_TAIL.startsWith('\n') ? '' : '\n\n') + SPEC_TAIL })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type === 'fork') return next(e)
    // 本 plugin 自己的 agent：不打 Jev、不改 model；planner 回來後附上最新規格摘要
    if (typeof e.subagent_type === 'string' && e.subagent_type.startsWith('system1:')) {
      const before = state.written.seq
      const res = await next(e)
      if (e.subagent_type === 'system1:planner' && res.deny === undefined && state.written.seq !== before) {
        const note = `system1 規格摘要（spec_id ${state.written.id}）：\n${state.written.report}`
        return { ...res, context: [...(res.context ?? []), note] } as typeof res
      }
      return res
    }
    const key = await $.env.get('TYPESAFE_API_KEY')
    if (!key) return next(e)

    let chosen: Model | null = null
    const abort = new AbortController()
    // 使用者中斷（next.signal）時，逾時等待一起結束；fetch 本身無法取消，只是不再等它
    const onStop = () => abort.abort()
    if (next.signal.aborted) onStop()
    else next.signal.addEventListener('abort', onStop)
    try {
      const body = JSON.stringify(buildRequest(e.description, e.prompt))
      const call = $.http
        .fetch(API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
        })
        .then(r => (r.ok ? parseNouls(r.text) : null))
      const timeout = $.clock.sleep(TIMEOUT_MS, { signal: abort.signal }).then(
        () => null,
        () => null,
      )
      const nouls = await Promise.race([call, timeout])
      call.catch(() => {})
      if (nouls) chosen = decideModel(nouls)
    } catch {
      chosen = null // 不記錄 headers／key
    } finally {
      abort.abort()
      next.signal.removeEventListener('abort', onStop)
    }

    $.ui.status(statusText(chosen, e.model))
    return chosen ? next({ ...e, model: chosen }) : next(e)
  }).catch(($, e, next) => next(e))
}
