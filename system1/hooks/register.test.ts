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
  expect(statusText('opus', undefined)).toBe('system1: opus（原 未指定）')
  expect(statusText('sonnet', 'sonnet')).toBe('system1: sonnet')
  expect(statusText(null, 'haiku')).toBe('system1: 保留 haiku')
  expect(statusText(null, undefined)).toBe('system1: 保留 未指定')
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
    expect(r.statuses).toEqual(['system1: 保留 haiku'])
  })
}

test('逾時 3 秒：不動', async ($, on) => {
  const clock = mock.clock(on)
  const r = await run($, on, { key: 'k', http: 'hang' }, {}, clock)
  await clock.advance(3000)
  await r.pending
  expect(r.reached().model).toBe(undefined)
  expect(r.statuses).toEqual(['system1: 保留 未指定'])
})

test('成功：改寫 model、顯示原值，且 key 只放 Authorization', async ($, on) => {
  const r = await run($, on, { key: 'secret', noul: { needs_architecture: 0.9 } }, { model: 'sonnet' })
  await r.pending
  expect(r.reached().model).toBe('opus')
  expect(r.statuses).toEqual(['system1: opus（原 sonnet）'])
  expect(r.requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(r.requests[0]!.init.headers.Authorization).toBe('Bearer secret')
  expect(r.requests[0]!.init.body).not.toContain('secret')
})

test('成功但結果與原值相同：status 不加（原…）', async ($, on) => {
  const r = await run($, on, { key: 'k', noul: { modifies_code: 0.9 } }, { model: 'sonnet' })
  await r.pending
  expect(r.reached().model).toBe('sonnet')
  expect(r.statuses).toEqual(['system1: sonnet'])
})

test('不確定帶：保留原值', async ($, on) => {
  const r = await run($, on, { key: 'k', noul: { needs_architecture: 0.5 } }, {})
  await r.pending
  expect(r.reached().model).toBe(undefined)
  expect(r.statuses).toEqual(['system1: 保留 未指定'])
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
  expect(statuses).toEqual(['system1: 保留 haiku'])
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
