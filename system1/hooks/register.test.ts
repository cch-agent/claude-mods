import { test, expect, mock } from 'claude-code/testing'

import { decideModel, parseNouls, buildRequest, statusText, type Nouls } from './register'

const base: Nouls = {
  needs_architecture: 0.1,
  needs_deep_reasoning: 0.1,
  design_settled: 0.1,
  modifies_code: 0.1,
  lookup_or_chore: 0.1,
}
const n = (o: Partial<Nouls>): Nouls => ({ ...base, ...o })

test('decideModel：各分支', () => {
  expect(decideModel(n({ needs_architecture: 0.9 }))).toBe('opus')
  expect(decideModel(n({ needs_deep_reasoning: 0.8, modifies_code: 0.9 }))).toBe('opus')
  // 架構高但已定案 → 不走 opus，落到 sonnet
  expect(decideModel(n({ needs_architecture: 0.9, design_settled: 0.9, modifies_code: 0.9 }))).toBe('sonnet')
  expect(decideModel(n({ lookup_or_chore: 0.9, modifies_code: 0.1 }))).toBe('haiku')
  expect(decideModel(n({ lookup_or_chore: 0.9, modifies_code: 0.9 }))).toBe('sonnet')
  expect(decideModel(n({ modifies_code: 0.9 }))).toBe('sonnet')
  expect(decideModel(n({ design_settled: 0.9 }))).toBe('sonnet')
  expect(decideModel(base)).toBe(null)
})

test('decideModel：邊界值與不確定帶', () => {
  expect(decideModel(n({ needs_architecture: 0.65 }))).toBe('opus')
  expect(decideModel(n({ needs_architecture: 0.5 }))).toBe(null)
  expect(decideModel(n({ needs_architecture: 0.35 }))).toBe(null) // 0.35 非帶內，但不足以 opus；其餘皆低
  expect(decideModel(n({ needs_architecture: 0.9, design_settled: 0.5 }))).toBe(null)
  expect(decideModel(n({ lookup_or_chore: 0.5 }))).toBe(null)
  expect(decideModel(n({ lookup_or_chore: 0.9, modifies_code: 0.5 }))).toBe(null)
  expect(decideModel(n({ lookup_or_chore: 0.9, modifies_code: 0.35 }))).toBe('haiku')
  expect(decideModel(n({ modifies_code: 0.5, design_settled: 0.5 }))).toBe(null)
  // 保守設計：關鍵題在不確定帶就回 null，不往下走到 sonnet
  expect(decideModel(n({ needs_architecture: 0.5, modifies_code: 0.9 }))).toBe(null)
  expect(decideModel(n({ modifies_code: 0.5, design_settled: 0.9 }))).toBe('sonnet')
})

test('parseNouls / buildRequest / statusText', () => {
  const ok = JSON.stringify({
    answers: Object.fromEntries(Object.keys(base).map(k => [k, { type: 'noul', noul: 0.5 }])),
  })
  expect(parseNouls(ok)?.modifies_code).toBe(0.5)
  expect(parseNouls('not json')).toBe(null)
  expect(parseNouls(JSON.stringify({ answers: { modifies_code: { noul: 0.5 } } }))).toBe(null)
  const req = buildRequest('d', 'x'.repeat(7000))
  expect(req.model).toBe('jev-latest')
  expect((req.state as { prompt: string }).prompt.length).toBe(6000)
  expect(Object.keys(req.questions).sort()).toEqual(Object.keys(base).sort())
  expect(JSON.stringify(req.questions)).toContain('`prompt`')
  expect(statusText('opus', undefined)).toBe('opus（原 未指定）')
  expect(statusText('sonnet', 'sonnet')).toBe('sonnet')
  expect(statusText(null, 'haiku')).toBe('保留 haiku')
  expect(statusText(null, undefined)).toBe('保留 未指定')
})

type Setup = {
  key?: string
  http?: 'ok' | 'error500' | 'badjson' | 'throw' | 'hang'
  noul?: Partial<Nouls>
}

async function run($: any, on: any, setup: Setup, input: Record<string, unknown>, clock = mock.clock(on)) {
  void clock
  mock.env(on, setup.key ? { TYPESAFE_API_KEY: setup.key } : {})
  const statuses: (string | undefined)[] = []
  const requests: { url: string; init: any }[] = []
  let reached: any
  on('ui.status', (_: unknown, e: any) => { statuses.push(e.text); return { value: undefined } as never })
  on('http.fetch', (_: unknown, e: any) => {
    requests.push(e)
    const mode = setup.http ?? 'ok'
    if (mode === 'throw') throw new Error('network down')
    if (mode === 'hang') return new Promise(() => {}) as never
    if (mode === 'error500') return { value: { status: 500, ok: false, headers: {}, text: 'x' } } as never
    if (mode === 'badjson') return { value: { status: 200, ok: true, headers: {}, text: '{' } } as never
    const o = { ...base, ...setup.noul }
    const answers = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: 'noul', noul: v }]))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } } as never
  })
  on('tool.call', (_: unknown, e: any) => { reached = e; return { result: { agentId: 'a', content: [], totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0 } } as never })
  const pending = $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', ...input })
  return { pending, statuses, requests, reached: () => reached }
}

test('fork 略過：不查 API、不改 model', async ($, on) => {
  const r = await run($, on, { key: 'k' }, { subagent_type: 'fork' })
  await r.pending
  expect(r.requests.length).toBe(0)
  expect(r.reached().model).toBe(undefined)
  expect(r.statuses.length).toBe(0)
})

test('無 key：不動', async ($, on) => {
  const r = await run($, on, {}, { model: 'haiku' })
  await r.pending
  expect(r.requests.length).toBe(0)
  expect(r.reached().model).toBe('haiku')
})

for (const mode of ['error500', 'badjson', 'throw'] as const) {
  test(`API 失敗（${mode}）：不動並顯示保留`, async ($, on) => {
    const r = await run($, on, { key: 'k', http: mode }, { model: 'haiku' })
    await r.pending
    expect(r.reached().model).toBe('haiku')
    expect(r.statuses).toEqual(['保留 haiku'])
  })
}

test('逾時 3 秒：不動', async ($, on) => {
  const clock = mock.clock(on)
  const r = await run($, on, { key: 'k', http: 'hang' }, {}, clock)
  await clock.advance(3000)
  await r.pending
  expect(r.reached().model).toBe(undefined)
  expect(r.statuses).toEqual(['保留 未指定'])
})

test('成功：改寫 model、顯示原值，且 key 只放 Authorization', async ($, on) => {
  const r = await run($, on, { key: 'secret', noul: { needs_architecture: 0.9 } }, { model: 'sonnet' })
  await r.pending
  expect(r.reached().model).toBe('opus')
  expect(r.statuses).toEqual(['opus（原 sonnet）'])
  expect(r.requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(r.requests[0]!.init.headers.Authorization).toBe('Bearer secret')
  expect(r.requests[0]!.init.body).not.toContain('secret')
})

test('成功但結果與原值相同：status 不加（原…）', async ($, on) => {
  const r = await run($, on, { key: 'k', noul: { modifies_code: 0.9 } }, { model: 'sonnet' })
  await r.pending
  expect(r.reached().model).toBe('sonnet')
  expect(r.statuses).toEqual(['sonnet'])
})

test('不確定帶：保留原值', async ($, on) => {
  const r = await run($, on, { key: 'k', noul: { needs_architecture: 0.5 } }, {})
  await r.pending
  expect(r.reached().model).toBe(undefined)
  expect(r.statuses).toEqual(['保留 未指定'])
})

test('status 不含 key', async ($, on) => {
  const r = await run($, on, { key: 'sk-test-12345', noul: { needs_architecture: 0.9 } }, {})
  await r.pending
  expect(r.statuses.join()).not.toContain('sk-test-12345')
})

test('回應缺欄位：不動', async ($, on) => {
  mock.clock(on)
  mock.env(on, { TYPESAFE_API_KEY: 'k' })
  const statuses: (string | undefined)[] = []
  let calls = 0
  let reached: any
  on('ui.status', (_: unknown, e: any) => { statuses.push(e.text); return { value: undefined } as never })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { modifies_code: { type: 'noul', noul: 0.9 } } }) } }) as never)
  on('tool.call', (_: unknown, e: any) => { calls++; reached = e; return { result: { agentId: 'a', content: [], totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0 } } as never })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', model: 'haiku' })
  expect(calls).toBe(1)
  expect(reached.model).toBe('haiku')
  expect(statuses).toEqual(['保留 haiku'])
})

test('hook 內拋錯（.catch 路徑）：原樣放行，Agent 只執行一次', async ($, on) => {
  mock.clock(on)
  on('env.get', () => { throw new Error('env broke') })
  let calls = 0
  let reached: any
  on('http.fetch', () => {
    const answers = Object.fromEntries(Object.entries({ ...base, needs_architecture: 0.9 }).map(([k, v]) => [k, { type: 'noul', noul: v }]))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } } as never
  })
  on('tool.call', (_: unknown, e: any) => { calls++; reached = e; return { result: { agentId: 'a', content: [], totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0 } } as never })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', model: 'haiku' })
  expect(calls).toBe(1)
  expect(reached.model).toBe('haiku')
})

// ───────────────────────── 第 2 階段：規格檔 ─────────────────────────

const ROOT = '/repo'
const SUBMIT = 'mcp__system1__submit_plan'
const CONFIRM = 'mcp__system1__confirm_plan'
const SPECS = `${ROOT}/context/specs`

type World = {
  files: Map<string, string>
  writes: string[]
  requests: { url: string; init: any }[]
  asked: string[]
  registered: { tools: any[]; agents: any[] }
  clock: ReturnType<typeof mock.clock>
}
type WorldOpts = {
  key?: string
  http?: 'ok' | 'error500' | 'badjson' | 'hang'
  score?: (requirement: string) => number
  answer?: string | 'reject'
  git?: boolean
  files?: Record<string, string>
  onAsk?: (w: World) => void
  failTool?: string
}

/** 在 `on` 之下搭一個記憶體內的世界：fs、git、Jev、AskUserQuestion、註冊。 */
function world(on: any, o: WorldOpts = {}): World {
  const w: World = {
    files: new Map(Object.entries(o.files ?? {})),
    writes: [],
    requests: [],
    asked: [],
    registered: { tools: [], agents: [] },
    clock: mock.clock(on),
  }
  mock.env(on, o.key ? { TYPESAFE_API_KEY: o.key } : {})
  const isDir = (p: string) => [...w.files.keys()].some(f => f.startsWith(p + '/')) || p === ROOT
  on('process.run', (_: unknown, e: any) => {
    if (o.git === false) throw new Error('no git')
    const a = e.argv.join(' ')
    if (a === 'git rev-parse --show-toplevel') return { value: { exitCode: 0, stdout: ROOT + '\n', stderr: '' } } as never
    if (a === 'git rev-parse HEAD') return { value: { exitCode: 0, stdout: 'abc123\n', stderr: '' } } as never
    return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
  })
  on('session.cwd', () => ({ value: ROOT }) as never)
  on('fs.read', (_: unknown, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t } as never
  })
  on('fs.write', (_: unknown, e: any) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined } as never
  })
  on('fs.list', (_: unknown, e: any) => {
    const names = [...w.files.keys()].filter(f => f.startsWith(e.path + '/') && !f.slice(e.path.length + 1).includes('/'))
    return { value: names.map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.stat', (_: unknown, e: any) => {
    const p: string = e.path
    if (w.files.has(p)) return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: p } } as never
    if (isDir(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: p } } as never
    throw new Error('ENOENT')
  })
  on('http.fetch', (_: unknown, e: any) => {
    w.requests.push(e)
    const mode = o.http ?? 'ok'
    if (mode === 'hang') return new Promise(() => {}) as never
    if (mode === 'error500') return { value: { status: 500, ok: false, headers: {}, text: 'x' } } as never
    if (mode === 'badjson') return { value: { status: 200, ok: true, headers: {}, text: '{' } } as never
    const body = JSON.parse(e.init.body)
    const v = (o.score ?? (() => 0.9))(body.state.requirement)
    const answers = Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: 'noul', noul: v }]))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    w.asked.push(e.questions[0].question)
    o.onAsk?.(w)
    if (o.answer === 'reject') throw new Error('no one to ask')
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: o.answer ?? '確認' } } } as never
  })
  on('tool.register', (_: unknown, e: any) => { if (e.name === o.failTool) throw new Error('boom'); w.registered.tools.push(e); return { value: { tool: `mcp__system1__${e.name}` } } as never })
  on('agent.register', (_: unknown, e: any) => { w.registered.agents.push(e); return { value: { agent: `system1:${e.name}` } } as never })
  return w
}

const REQS = [
  { id: 'R1', text: '空輸入時 extract() 回傳空陣列', verify_by: 'test' },
  { id: 'R2', text: 'extract.ts 之外的檔案不被修改', verify_by: 'jev' },
]
const plan = (o: Record<string, unknown> = {}) => ({
  tool: SUBMIT,
  slug: 'extract-empty',
  intent: '修正空輸入',
  requirements: REQS,
  out_of_scope: [],
  ...o,
})
const textOf = (r: any): string => (typeof r.result === 'string' ? r.result : (r.text ?? JSON.stringify(r.result)))
const readJson = (w: World, p: string) => JSON.parse(w.files.get(p)!)
const specPath = (w: World) => w.writes.find(p => p.startsWith(SPECS + '/'))!

test('session.start 註冊 submit_plan、confirm_plan 與 planner', async ($, on) => {
  const w = world(on)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT } as any)
  const names = w.registered.tools.map(t => t.name)
  expect(names).toEqual(['submit_plan', 'confirm_plan'])
  expect(w.registered.tools[0].isDeferred).toBe(false)
  const planner = w.registered.agents[0]
  expect(planner.name).toBe('planner')
  expect(planner.model).toBe('opus')
  expect(planner.tools).toEqual(['Read', 'Bash', SUBMIT])
  expect(planner.maxTurns).toBe(40)
  expect(planner.prompt.length).toBeGreaterThan(100)
})

test('submit_plan 正常：寫檔、第 3 層 ok、status draft', async ($, on) => {
  const w = world(on, { key: 'k' })
  const r = await $.tool.call(plan() as any)
  expect(w.writes.length).toBe(1)
  const spec = readJson(w, specPath(w))
  expect(spec.schema).toBe(1)
  expect(spec.status).toBe('draft')
  expect(spec.confirmed_at).toBe(undefined)
  expect(spec.id).toMatch(/^\d{8}-\d{4}-extract-empty$/)
  expect(spec.checks.round).toBe(1)
  expect(spec.checks.revision).toBe(1)
  expect(spec.checks.agent).toBe('main')
  expect(spec.checks.layer3.status).toBe('ok')
  expect(spec.checks.layer3.items.R1.verdict).toBe('pass')
  expect(w.requests.length).toBe(2)
  expect(w.requests[0]!.init.headers.Authorization).toBe('Bearer k')
  expect(w.requests[0]!.init.body).not.toContain('"k"')
  expect(textOf(r)).toContain(spec.id)
})

test('submit_plan 無 key：只跑第 2 層、照樣寫檔並註明', async ($, on) => {
  const w = world(on)
  const r = await $.tool.call(plan({ requirements: [{ id: 'R1', text: '改 a.ts 且改 b.ts', verify_by: 'jev' }] }) as any)
  const spec = readJson(w, specPath(w))
  expect(spec.checks.layer3.status).toBe('skipped:no-key')
  expect(spec.checks.layer2.R1).toContain('conjunction:且')
  expect(w.requests.length).toBe(0)
  expect(textOf(r)).toContain('第 3 層未執行：skipped:no-key')
})

for (const mode of ['error500', 'badjson'] as const) {
  test(`submit_plan Jev 失敗（${mode}）：退回第 2 層並寫檔`, async ($, on) => {
    const w = world(on, { key: 'k', http: mode })
    const r = await $.tool.call(plan() as any)
    const spec = readJson(w, specPath(w))
    expect(spec.checks.layer3.status).toBe('error')
    expect(spec.checks.layer3.items).toEqual({})
    expect(textOf(r)).toContain('第 3 層未執行：error')
  })
}

test('submit_plan 第 3 層逾時 8 秒：timeout、仍寫檔', async ($, on) => {
  const w = world(on, { key: 'k', http: 'hang' })
  const pending = $.tool.call(plan() as any)
  await w.clock.advance(8000)
  const r = await pending
  expect(readJson(w, specPath(w)).checks.layer3.status).toBe('timeout')
  expect(textOf(r)).toContain('第 3 層未執行：timeout')
})

test('submit_plan 併發上限 4：6 條需求同時最多 4 個請求在途', async ($, on) => {
  const w = world(on, { key: 'k', http: 'hang' })
  const reqs = Array.from({ length: 6 }, (_, i) => ({ id: `R${i + 1}`, text: `條目 ${i + 1}`, verify_by: 'jev' }))
  const pending = $.tool.call(plan({ requirements: reqs }) as any)
  await w.clock.settle()
  expect(w.requests.length).toBe(4)
  await w.clock.advance(8000)
  await pending
})

test('submit_plan 超過 30 條：只送前 30 條給 Jev', async ($, on) => {
  const w = world(on, { key: 'k' })
  const reqs = Array.from({ length: 32 }, (_, i) => ({ id: `R${i + 1}`, text: `條目 ${i + 1}`, verify_by: 'jev' }))
  const r = await $.tool.call(plan({ requirements: reqs }) as any)
  expect(w.requests.length).toBe(30)
  expect(textOf(r)).toContain('超過 30 條')
})

test('submit_plan schema 錯誤：不寫檔、回錯誤', async ($, on) => {
  const w = world(on, { key: 'k' })
  const r = await $.tool.call(plan({ requirements: [] }) as any)
  expect(w.writes.length).toBe(0)
  expect(w.requests.length).toBe(0)
  expect(textOf(r)).toContain('requirements')
})

test('submit_plan 忽略呼叫者傳入的 status／checks／confirmed_at／base_commit', async ($, on) => {
  const w = world(on)
  await $.tool.call(
    plan({
      status: 'confirmed',
      confirmed_at: '2026-01-01T00:00:00Z',
      base_commit: 'evil',
      checks: { round: 9, revision: 9, agent: 'x', layer2: {}, layer3: { status: 'ok', items: {} } },
    }) as any,
  )
  const spec = readJson(w, specPath(w))
  expect(spec.status).toBe('draft')
  expect(spec.confirmed_at).toBe(undefined)
  expect(spec.base_commit).toBe(undefined)
  expect(spec.checks.round).toBe(1)
  expect(spec.checks.agent).toBe('main')
})

test('submit_plan 輪數：同 agent 第 2、3 輪寫檔（3 為最終），第 4 輪拒絕不寫檔', async ($, on) => {
  const w = world(on)
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  const r2 = await $.tool.call(plan({ spec_id: id }) as any)
  expect(readJson(w, p).checks.round).toBe(2)
  expect(textOf(r2)).not.toContain('已達重寫上限')
  const r3 = await $.tool.call(plan({ spec_id: id }) as any)
  expect(readJson(w, p).checks.round).toBe(3)
  expect(textOf(r3)).toContain('已達重寫上限')
  const before = w.writes.length
  const r4 = await $.tool.call(plan({ spec_id: id }) as any)
  expect(w.writes.length).toBe(before)
  expect(readJson(w, p).checks.round).toBe(3)
  expect(textOf(r4)).toContain('拒絕')
})

test('submit_plan 換 agent：revision+1、round 重算；revision 3 後不再提問', async ($, on) => {
  const w = world(on)
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  await $.tool.call({ ...plan({ spec_id: id }), agentId: 'a1' } as any)
  let c = readJson(w, p).checks
  expect([c.revision, c.round, c.agent]).toEqual([2, 1, 'a1'])
  const r = await $.tool.call({ ...plan({ spec_id: id }), agentId: 'a2' } as any)
  c = readJson(w, p).checks
  expect([c.revision, c.round]).toEqual([3, 1])
  expect(textOf(r)).toContain('不再提問')
})

test('submit_plan 帶不存在的 spec_id：不寫檔', async ($, on) => {
  const w = world(on)
  const r = await $.tool.call(plan({ spec_id: 'nope-1' }) as any)
  expect(w.writes.length).toBe(0)
  expect(textOf(r)).toContain('找不到')
})

test('confirm_plan 確認：confirmed、confirmed_at、base_commit，並把舊 confirmed 標 superseded', async ($, on) => {
  const old = { schema: 1, id: 'old-1', status: 'confirmed', confirmed_at: '2026-01-01T00:00:00.000Z', requirements: [], checks: {} }
  const w = world(on, { files: { [`${SPECS}/old-1.json`]: JSON.stringify(old) } })
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  const r = await $.tool.call({ tool: CONFIRM, spec_id: id } as any)
  const spec = readJson(w, p)
  expect(spec.status).toBe('confirmed')
  expect(spec.confirmed_at).toMatch(/^\d{4}-/)
  expect(spec.base_commit).toBe('abc123')
  expect(readJson(w, `${SPECS}/old-1.json`).status).toBe('superseded')
  expect(w.asked[0]).toContain('共 2 條')
  expect(w.asked[0]).toContain('0 個未解問題')
  expect(textOf(r)).toContain('abc123')
})

for (const [answer, label] of [['取消', '取消'], ['修改', '修改'], ['把 R2 拆開', '修改（Other 輸入）']] as const) {
  test(`confirm_plan ${label}：維持 draft`, async ($, on) => {
    const w = world(on, { answer })
    await $.tool.call(plan() as any)
    const p = specPath(w)
    const id = readJson(w, p).id
    const r = await $.tool.call({ tool: CONFIRM, spec_id: id } as any)
    expect(readJson(w, p).status).toBe('draft')
    expect(readJson(w, p).confirmed_at).toBe(undefined)
    if (answer === '把 R2 拆開') expect(textOf(r)).toContain('把 R2 拆開')
  })
}

test('confirm_plan $.ui.ask reject（-p 模式）：維持 draft', async ($, on) => {
  const w = world(on, { answer: 'reject' })
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  const r = await $.tool.call({ tool: CONFIRM, spec_id: id } as any)
  expect(readJson(w, p).status).toBe('draft')
  expect(textOf(r)).toContain('維持 draft')
})

test('已 confirmed 的規格經 submit_plan 修改 → 回 draft、清掉 confirmed_at', async ($, on) => {
  const w = world(on)
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  await $.tool.call({ tool: CONFIRM, spec_id: id } as any)
  expect(readJson(w, p).status).toBe('confirmed')
  await $.tool.call({ ...plan({ spec_id: id }), agentId: 'a1' } as any)
  const spec = readJson(w, p)
  expect(spec.status).toBe('draft')
  expect(spec.confirmed_at).toBe(undefined)
  expect(spec.base_commit).toBe(undefined)
})

test('根目錄解析：git 失敗退回 session.cwd', async ($, on) => {
  const w = world(on, { git: false })
  await $.tool.call(plan() as any)
  expect(specPath(w).startsWith(`${ROOT}/context/specs/`)).toBe(true)
})

test('寫入防護：擋 context/specs/x.json，放行其他', async ($, on) => {
  const w = world(on, { files: { [`${SPECS}/x.json`]: '{}' } })
  let reached = 0
  on('tool.call', { tool: 'Write' }, () => { reached++; return { result: { type: 'update' } } as never })
  on('tool.call', { tool: 'Edit' }, () => { reached++; return { result: { type: 'update' } } as never })
  const denied = await $.tool.call({ tool: 'Write', file_path: `${SPECS}/x.json`, content: '{}' } as any)
  expect(denied.deny).toContain('submit_plan')
  const deniedNew = await $.tool.call({ tool: 'Write', file_path: `${SPECS}/new.json`, content: '{}' } as any)
  expect(deniedNew.deny).toContain('submit_plan')
  const deniedEdit = await $.tool.call({ tool: 'Edit', file_path: `${SPECS}/x.json`, old_string: 'a', new_string: 'b' } as any)
  expect(deniedEdit.deny).toContain('submit_plan')
  expect(reached).toBe(0)
  for (const p of [`${ROOT}/context/progress.md`, `${SPECS}/sub/x.json`, `${SPECS}/x.md`, `${ROOT}/src/a.ts`]) {
    const ok = await $.tool.call({ tool: 'Write', file_path: p, content: 'x' } as any)
    expect(ok.deny).toBe(undefined)
  }
  expect(reached).toBe(4)
  void w
})

test('Agent hook：system1:planner 不打 Jev、不改 model，回來後附規格摘要 context', async ($, on) => {
  const w = world(on, { key: 'k' })
  let reached: any
  on('tool.call', { tool: 'Agent' }, async (_: unknown, e: any) => {
    reached = e
    await $.tool.call(plan() as any) // 模擬 planner 在子 agent 內送出規格
    return { result: { agentId: 'a', content: [], totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0 } } as never
  })
  const before = w.requests.length
  const r: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'system1:planner', model: 'sonnet' })
  expect(reached.model).toBe('sonnet')
  // 只有 submit_plan 的 2 次第 3 層請求；Agent 本身沒有多打
  expect(w.requests.length - before).toBe(2)
  expect(w.requests.every(q => q.init.body.includes('"requirement"'))).toBe(true)
  expect(r.context?.join('\n')).toContain('system1 規格摘要')
  expect(r.context?.join('\n')).toContain(readJson(w, specPath(w)).id)
})

test('Agent hook：其他 system1: agent 同樣不打 Jev，且不附 context', async ($, on) => {
  const w = world(on, { key: 'k' })
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a', content: [], totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0 } }) as never)
  const r: any = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'system1:other' })
  expect(w.requests.length).toBe(0)
  expect(r.context).toBe(undefined)
})

import { SPEC_TAIL } from './prompts'

const skillWorld = (on: any, lower?: (e: any) => string) => {
  on('prompt.submit', (_: unknown, e: any) => ({ text: e.text }) as never)
  return on('skill.prompt', (_: unknown, e: any) => ({ text: lower ? lower(e) : e.text }) as never)
}

test('skill.prompt：grilling 附加一次 SPEC_TAIL，原文在前', async ($, on) => {
  skillWorld(on)
  const r = await $.skill.prompt({ skill: 'grilling', text: 'ORIGINAL' })
  expect(r.text.startsWith('ORIGINAL')).toBe(true)
  expect(r.text.split(SPEC_TAIL).length - 1).toBe(1)
  await $.prompt.submit({ text: 'p' } as any) // 換回合
  const q = await $.skill.prompt({ skill: 'mattpocock-skills:grilling', text: 'ORIGINAL' })
  expect(q.text.split(SPEC_TAIL).length - 1).toBe(1)
})

test('skill.prompt：同一回合 grill-with-docs → grilling 只有第一個被附加', async ($, on) => {
  skillWorld(on)
  const a = await $.skill.prompt({ skill: 'grill-with-docs', text: 'DOCS' })
  const b = await $.skill.prompt({ skill: 'grilling', text: 'GRILL' })
  expect(a.text.startsWith('DOCS')).toBe(true)
  expect(a.text.split(SPEC_TAIL).length - 1).toBe(1)
  expect(b.text).toBe('GRILL')
})

test('skill.prompt：名稱含 grill／plan（不分大小寫、含前綴）會附加', async ($, on) => {
  skillWorld(on)
  for (const skill of ['grill-me', 'writing-plans', 'Planning', 'x:PLAN-review']) {
    // 每個 skill 之間以 prompt.submit 換回合，避免旗標互相影響
    await $.prompt.submit({ text: 'p' } as any)
    const r = await $.skill.prompt({ skill, text: 'T' })
    expect(r.text.split(SPEC_TAIL).length - 1, skill).toBe(1)
  }
})

test('skill.prompt：domain-modeling、tdd 不附加', async ($, on) => {
  skillWorld(on)
  for (const skill of ['domain-modeling', 'tdd']) {
    const r = await $.skill.prompt({ skill, text: 'T' })
    expect(r.text, skill).toBe('T')
  }
})

test('skill.prompt：經過 prompt.submit 後，下一個 grilling 又會附加', async ($, on) => {
  skillWorld(on)
  const a = await $.skill.prompt({ skill: 'grilling', text: 'A' })
  const b = await $.skill.prompt({ skill: 'grilling', text: 'B' })
  await $.prompt.submit({ text: 'p' } as any)
  const c = await $.skill.prompt({ skill: 'grilling', text: 'C' })
  expect(a.text).toContain(SPEC_TAIL)
  expect(b.text).toBe('B')
  expect(c.text).toContain(SPEC_TAIL)
})

test('skill.prompt：其他 skill 不變', async ($, on) => {
  skillWorld(on)
  const r = await $.skill.prompt({ skill: 'commit', text: 'X' })
  expect(r.text).toBe('X')
})

test('skill.prompt：下層 hook 也附加時兩段都保留', async ($, on) => {
  skillWorld(on, e => e.text + '\n[OTHER]')
  const r = await $.skill.prompt({ skill: 'grilling', text: 'ORIGINAL' })
  expect(r.text).toContain('[OTHER]')
  expect(r.text).toContain(SPEC_TAIL)
  expect(r.text.startsWith('ORIGINAL')).toBe(true)
})

test('session.start：一個註冊失敗不連帶其他', async ($, on) => {
  const w = world(on, { failTool: 'submit_plan' })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT } as any)
  expect(w.registered.tools.map(t => t.name)).toEqual(['confirm_plan'])
  expect(w.registered.agents.length).toBe(1)
})

test('agent.spawn：system1:planner 強制前景，其他不動', async ($, on) => {
  let seen: any[] = []
  on('agent.spawn', (_: unknown, e: any) => { seen.push(e.background); return { model: 'opus', agentId: 'a' } as never })
  world(on)
  await $.agent.spawn({ prompt: 'p', subagentType: 'system1:planner', background: true } as any)
  await $.agent.spawn({ prompt: 'p', subagentType: 'general-purpose', background: true } as any)
  expect(seen).toEqual([false, true])
})

test('寫入防護：context/specs 資料夾不存在時仍擋；Context/Specs 大小寫別名也擋；含 .. 的未建路徑擋', async ($, on) => {
  world(on) // 沒有任何檔案：specs 資料夾不存在
  let reached = 0
  on('tool.call', { tool: 'Write' }, () => { reached++; return { result: { type: 'create' } } as never })
  for (const p of [`${SPECS}/x.json`, `${ROOT}/Context/Specs/x.json`, `${ROOT}/context/nope/../specs/x.json`, 'context/specs/x.json']) {
    const r = await $.tool.call({ tool: 'Write', file_path: p, content: '{}' } as any)
    expect(r.deny).toContain('submit_plan')
  }
  expect(reached).toBe(0)
  const ok = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/context/other/x.json`, content: '{}' } as any)
  expect(ok.deny).toBe(undefined)
})

test('不信任檔案內容的 id：內容 id 與檔名不符的規格視為不存在，也不被覆寫或 superseded', async ($, on) => {
  const evil = JSON.stringify({ schema: 1, id: '../../x', status: 'confirmed', confirmed_at: '2026-01-01T00:00:00.000Z', requirements: [], checks: {} })
  const mismatch = JSON.stringify({ schema: 1, id: 'other-id', status: 'confirmed', confirmed_at: '2026-01-01T00:00:00.000Z', requirements: [], checks: {} })
  const w = world(on, { files: { [`${SPECS}/evil.json`]: evil, [`${SPECS}/mis.json`]: mismatch } })
  const r = await $.tool.call(plan({ spec_id: 'evil' }) as any)
  expect(textOf(r)).toContain('找不到')
  expect(w.writes.length).toBe(0)
  // confirm 新規格時不碰這兩個
  await $.tool.call(plan() as any)
  const id = readJson(w, specPath(w)).id
  await $.tool.call({ tool: CONFIRM, spec_id: id } as any)
  expect(w.files.get(`${SPECS}/evil.json`)).toBe(evil)
  expect(w.files.get(`${SPECS}/mis.json`)).toBe(mismatch)
  expect(w.writes.every(p => p.startsWith(SPECS + '/'))).toBe(true)
  expect(w.writes.some(p => p.includes('..'))).toBe(false)
})

test('confirm_plan：詢問期間規格被更新 → 不確認', async ($, on) => {
  const w = world(on, {
    onAsk: w => {
      const p = [...w.files.keys()].find(k => k.startsWith(SPECS + '/'))!
      const s = JSON.parse(w.files.get(p)!)
      s.checks.round = 2
      w.files.set(p, JSON.stringify(s))
    },
  })
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  const r = await $.tool.call({ tool: CONFIRM, spec_id: id } as any)
  expect(textOf(r)).toContain('規格已更新，請重新確認'.replace('規格已更新', `規格 ${id} 已更新`))
  expect(readJson(w, p).status).toBe('draft')
})

test('第 4 輪拒絕訊息含「已達重寫上限」；revision 超限時含「不再提問」', async ($, on) => {
  const w = world(on)
  await $.tool.call(plan() as any)
  const p = specPath(w)
  const id = readJson(w, p).id
  for (let i = 0; i < 2; i++) await $.tool.call(plan({ spec_id: id }) as any)
  const r4 = await $.tool.call(plan({ spec_id: id }) as any)
  expect(textOf(r4)).toContain('已達重寫上限')
  // revision 3 後的 reject
  const s = readJson(w, p)
  s.checks.revision = 3
  w.files.set(p, JSON.stringify(s))
  const r = await $.tool.call(plan({ spec_id: id }) as any)
  expect(textOf(r)).toContain('不再提問')
})
