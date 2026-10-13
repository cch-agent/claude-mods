import { test, expect } from 'claude-code/testing'

import {
  validateSpec,
  flagSuspicious,
  buildItemRequest,
  parseItemAnswer,
  judgeItem,
  roundState,
  formatReport,
  pickActiveSpec,
  makeSpecId,
  isGuardedSpecPath,
  type Checks,
  type Spec,
} from './plan'

const goodInput = () => ({
  slug: 'x',
  intent: '空字串不再丟錯',
  requirements: [
    { id: 'R1', text: 'extract("") 回傳 []', verify_by: 'test' },
    { id: 'R2a', text: '不修改 foo.ts', verify_by: 'agent' },
  ],
  out_of_scope: ['重構'],
})
const errorsOf = (i: unknown) => {
  const r = validateSpec(i)
  return r.ok ? [] : r.errors
}

test('validateSpec：合法輸入', () => {
  const r = validateSpec(goodInput())
  expect(r.ok).toBe(true)
  const withOq = { ...goodInput(), open_questions: [{ req_id: 'R1', question: 'q', options: ['a', 'b'], recommended: 1, why: 'w' }] }
  expect(validateSpec(withOq).ok).toBe(true)
})

test('validateSpec：各種 schema 錯誤', () => {
  expect(validateSpec(null).ok).toBe(false)
  expect(errorsOf({ ...goodInput(), intent: '' }).join()).toContain('intent')
  const { intent: _i, ...noIntent } = goodInput()
  expect(errorsOf(noIntent).join()).toContain('intent')
  expect(errorsOf({ ...goodInput(), requirements: [] }).join()).toContain('requirements')
  expect(errorsOf({ ...goodInput(), requirements: [{ id: 'X1', text: 't', verify_by: 'test' }] }).join()).toContain('id')
  expect(errorsOf({ ...goodInput(), requirements: [{ id: 'R1', text: 't', verify_by: 'test' }, { id: 'R1', text: 't', verify_by: 'test' }] }).join()).toContain('重複')
  expect(errorsOf({ ...goodInput(), requirements: [{ id: 'R1', text: 't', verify_by: 'human' }] }).join()).toContain('verify_by')
  expect(errorsOf({ ...goodInput(), out_of_scope: 'x' }).join()).toContain('out_of_scope')
  expect(errorsOf({ ...goodInput(), out_of_scope: [1] }).join()).toContain('out_of_scope')
})

test('validateSpec：open_questions 格式與 req_id', () => {
  const oq = (o: object) => ({ ...goodInput(), open_questions: [{ req_id: 'R1', question: 'q', options: ['a', 'b'], recommended: 0, why: 'w', ...o }] })
  expect(errorsOf(oq({ req_id: 'R9' })).join()).toContain('req_id')
  expect(errorsOf(oq({ options: ['a'] })).join()).toContain('options')
  expect(errorsOf(oq({ options: ['a', 'b', 'c', 'd', 'e'] })).join()).toContain('options')
  expect(errorsOf(oq({ options: ['a', 2] })).join()).toContain('options')
  expect(errorsOf(oq({ recommended: 2 })).join()).toContain('recommended')
  expect(errorsOf(oq({ recommended: -1 })).join()).toContain('recommended')
  expect(errorsOf(oq({ recommended: 0.5 })).join()).toContain('recommended')
  expect(errorsOf(oq({ question: '' })).join()).toContain('question')
  expect(errorsOf({ ...goodInput(), open_questions: 'x' }).join()).toContain('open_questions')
  // 多個錯誤一次回報
  expect(errorsOf({ ...goodInput(), intent: '', out_of_scope: 1 }).length).toBe(2)
})

test('validateSpec：多餘欄位丟掉', () => {
  const r = validateSpec({
    ...goodInput(),
    requirements: [{ id: 'R1', text: 't', verify_by: 'test', verdict: 'pass', extra: 1 }],
    open_questions: [{ req_id: 'R1', question: 'q', options: ['a', 'b'], recommended: 0, why: 'w', verdict: 'fail' }],
  })
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.value.requirements[0]).toEqual({ id: 'R1', text: 't', verify_by: 'test' })
    expect(r.value.open_questions?.[0]).toEqual({ req_id: 'R1', question: 'q', options: ['a', 'b'], recommended: 0, why: 'w' })
  }
})

test('flagSuspicious：連接詞、指代詞、長句', () => {
  expect(flagSuspicious('新增檢查且更新文件')).toEqual(['conjunction:且'])
  expect(flagSuspicious('改 a 以及 b')).toEqual(['conjunction:以及'])
  expect(flagSuspicious('改 a 並且改 b')).toEqual(['conjunction:並且'])
  expect(flagSuspicious('改 a 並改 b')).toEqual(['conjunction:並'])
  expect(flagSuspicious('同時處理 a')).toEqual(['conjunction:同時'])
  expect(flagSuspicious('add a, and add b')).toEqual(['conjunction:, and'])
  expect(flagSuspicious('照剛才說的做')).toEqual(['pronoun:剛才'])
  expect(flagSuspicious('依上述規則')).toContain('pronoun:上述')
  expect(flagSuspicious('這個函式要改')).toContain('pronoun:這個')
  expect(flagSuspicious('該函式要改')).toEqual(['pronoun:該'])
  expect(flagSuspicious('see above')).toEqual(['pronoun:above'])
  expect(flagSuspicious('a'.repeat(81))).toEqual(['long:81'])
  expect(flagSuspicious('a'.repeat(80))).toEqual([])
})

test('flagSuspicious：正常句不誤標', () => {
  expect(flagSuspicious('extract("") 回傳空陣列')).toEqual([])
  expect(flagSuspicious('函式應該回傳 0')).toEqual([]) // 「應該」不是指代詞
  expect(flagSuspicious('about the abode')).toEqual([])
  expect(flagSuspicious('register.ts 的 decideModel 在 0.35 時回傳 null')).toEqual([])
})

test('buildItemRequest：state 只含單條、testable 只在 test 條目', () => {
  const t = buildItemRequest({ id: 'R1', text: 'foo 回傳 1', verify_by: 'test' })
  expect(t.model).toBe('jev-latest')
  expect(t.state).toEqual({ requirement: 'foo 回傳 1', verify_by: 'test' })
  expect(Object.keys(t.questions).sort()).toEqual(['self_contained', 'single_condition', 'testable'])
  for (const vb of ['jev', 'agent'] as const) {
    const r = buildItemRequest({ id: 'R2', text: 'x', verify_by: vb })
    expect(Object.keys(r.questions).sort()).toEqual(['self_contained', 'single_condition'])
    expect(Object.keys(r.state).sort()).toEqual(['requirement', 'verify_by'])
  }
  expect(JSON.stringify(t.questions)).toContain('`requirement`')
})

const ans = (o: Record<string, number | undefined>) =>
  JSON.stringify({ answers: Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, { type: 'noul', noul: v }])) })

test('parseItemAnswer：正常、缺欄位、超出範圍', () => {
  expect(parseItemAnswer(ans({ single_condition: 0.9, self_contained: 0.4 }), 'jev')).toEqual({ single_condition: 0.9, self_contained: 0.4 })
  expect(parseItemAnswer(ans({ single_condition: 0.9, self_contained: 0.4, testable: 0.2 }), 'test')).toEqual({ single_condition: 0.9, self_contained: 0.4, testable: 0.2 })
  // 非 test 條目忽略 testable
  expect(parseItemAnswer(ans({ single_condition: 0.9, self_contained: 0.4, testable: 0.2 }), 'agent')).toEqual({ single_condition: 0.9, self_contained: 0.4 })
  expect(parseItemAnswer(ans({ single_condition: 0.9, self_contained: 0.4 }), 'test')).toBe(null)
  expect(parseItemAnswer(ans({ single_condition: 0.9 }), 'jev')).toBe(null)
  expect(parseItemAnswer(ans({ single_condition: 1.1, self_contained: 0.4 }), 'jev')).toBe(null)
  expect(parseItemAnswer(ans({ single_condition: -0.1, self_contained: 0.4 }), 'jev')).toBe(null)
  expect(parseItemAnswer(ans({ single_condition: 0, self_contained: 1 }), 'jev')).toEqual({ single_condition: 0, self_contained: 1 })
  expect(parseItemAnswer('not json', 'jev')).toBe(null)
  expect(parseItemAnswer('null', 'jev')).toBe(null)
  expect(parseItemAnswer('{}', 'jev')).toBe(null)
  expect(parseItemAnswer(JSON.stringify({ answers: { single_condition: { noul: '0.9' }, self_contained: { noul: 0.9 } } }), 'jev')).toBe(null)
})

test('judgeItem：邊界 0.35/0.65 與不確定帶', () => {
  expect(judgeItem({ single_condition: 0.9, self_contained: 0.9 })).toBe('pass')
  expect(judgeItem({ single_condition: 0.65, self_contained: 0.65 })).toBe('pass')
  expect(judgeItem({ single_condition: 0.64, self_contained: 0.9 })).toBe('unsure')
  expect(judgeItem({ single_condition: 0.36, self_contained: 0.9 })).toBe('unsure')
  expect(judgeItem({ single_condition: 0.35, self_contained: 0.9 })).toBe('fail')
  expect(judgeItem({ single_condition: 0.5, self_contained: 0.1 })).toBe('fail') // fail 優先於 unsure
  expect(judgeItem({ single_condition: 0.9, self_contained: 0.9, testable: 0.5 })).toBe('unsure')
  expect(judgeItem({ single_condition: 0.9, self_contained: 0.9, testable: 0.2 })).toBe('fail')
  expect(judgeItem({ single_condition: 0.9, self_contained: 0.9, testable: 0.9 })).toBe('pass')
})

const checks = (o: Partial<Checks>): Checks => ({ round: 1, revision: 1, agent: 'a1', layer2: {}, layer3: { status: 'ok', items: {} }, ...o })

test('roundState：首送與同 agent 輪數', () => {
  expect(roundState(undefined, 'a1')).toEqual({ round: 1, revision: 1, decision: 'write', askAllowed: true })
  expect(roundState(checks({ round: 1 }), 'a1')).toEqual({ round: 2, revision: 1, decision: 'write', askAllowed: true })
  expect(roundState(checks({ round: 2 }), 'a1')).toEqual({ round: 3, revision: 1, decision: 'write-final', askAllowed: true })
  expect(roundState(checks({ round: 3 }), 'a1')).toEqual({ round: 4, revision: 1, decision: 'reject', askAllowed: true })
  expect(roundState(checks({ round: 4 }), 'a1').decision).toBe('reject')
})

test('roundState：換 agent、revision 上限', () => {
  expect(roundState(checks({ round: 3, revision: 1 }), 'a2')).toEqual({ round: 1, revision: 2, decision: 'write', askAllowed: true })
  expect(roundState(checks({ round: 2, revision: 2 }), 'main')).toEqual({ round: 1, revision: 3, decision: 'write', askAllowed: false })
  expect(roundState(checks({ round: 1, revision: 3 }), 'a1')).toEqual({ round: 2, revision: 3, decision: 'write', askAllowed: false })
  // revision 硬上限：換 agent 後 revision 達 4 → reject
  expect(roundState(checks({ round: 1, revision: 3 }), 'a2')).toEqual({ round: 1, revision: 4, decision: 'reject', askAllowed: false })
  // 換 agent 後 round 3 不受之前輪數影響
  expect(roundState(checks({ round: 4, revision: 1, agent: 'a1' }), 'a2').decision).toBe('write')
})

const spec = (o: Partial<Spec> = {}): Spec => ({
  schema: 1,
  id: '20261013-1530-x',
  status: 'draft',
  created_at: '2026-10-13T15:30:00Z',
  intent: 'i',
  requirements: [
    { id: 'R1', text: '第一條', verify_by: 'test' },
    { id: 'R2', text: '第二條', verify_by: 'jev' },
    { id: 'R3', text: '第三條', verify_by: 'agent' },
    { id: 'R4', text: '第四條', verify_by: 'agent' },
  ],
  out_of_scope: [],
  open_questions: [{ req_id: 'R4', question: '上限多少？', options: ['10', '20'], recommended: 1, why: '簡報沒寫' }],
  checks: checks({
    round: 1,
    layer2: { R1: ['conjunction:且'], R2: [] },
    layer3: {
      status: 'ok',
      items: {
        R1: { single_condition: 0.5, self_contained: 0.9, testable: 0.8, verdict: 'unsure' },
        R2: { single_condition: 0.1, self_contained: 0.9, verdict: 'fail' },
        R3: { single_condition: 0.9, self_contained: 0.9, verdict: 'pass' },
      },
    },
  }),
  ...o,
})

test('formatReport：排序與指示句', () => {
  const r = formatReport(spec(), { decision: 'write', askAllowed: true })
  const at = (s: string) => r.indexOf(s)
  expect(at('待問題目')).toBeGreaterThan(-1)
  expect(at('待問題目')).toBeLessThan(at('未通過'))
  expect(at('未通過')).toBeLessThan(at('不確定'))
  expect(at('不確定')).toBeLessThan(at('第 2 層標記'))
  expect(r).toContain('R4：上限多少？')
  expect(r).toContain('R2')
  expect(r).toContain('第二條')
  expect(r).toContain('conjunction:且')
  expect(r).not.toContain('R3（') // pass 不列出
  expect(r).toContain('剩餘自動重寫 2 輪')
  expect(r).toContain('revision 1/3')
  expect(r).toContain('帶 spec_id 再送出')
  expect(r).not.toContain('已達重寫上限')
  expect(r).not.toContain('不再提問')
  expect(r).not.toContain('第 3 層未執行')
})

test('formatReport：write-final、askAllowed=false、第 3 層狀態', () => {
  const final = formatReport(spec({ checks: checks({ round: 3 }) }), { decision: 'write-final', askAllowed: true })
  expect(final).toContain('已達重寫上限：停止修改，回報 spec_id 與未通過條目')
  expect(final).toContain('剩餘自動重寫 0 輪')
  expect(final).not.toContain('帶 spec_id 再送出')
  const noAsk = formatReport(spec({ checks: checks({ revision: 3 }) }), { decision: 'write', askAllowed: false })
  expect(noAsk).toContain('不再提問，剩下的問題留在 open_questions，直接交 confirm')
  const skipped = formatReport(spec({ checks: checks({ layer3: { status: 'skipped:no-key', items: {} } }) }), { decision: 'write', askAllowed: true })
  expect(skipped).toContain('第 3 層未執行：skipped:no-key')
  const partial = formatReport(spec({ checks: checks({ layer3: { status: 'partial-timeout', items: {} } }) }), { decision: 'write', askAllowed: true })
  expect(partial).toContain('部分逾時')
})

test('formatReport：鎖住 planner 判斷結束用的關鍵字', () => {
  // 有 fail/unsure 且未列入 open_questions → 不含「全部通過」
  expect(formatReport(spec(), { decision: 'write', askAllowed: true })).not.toContain('全部通過')
  // 全 pass → 含「全部通過」
  const allPass = spec({ open_questions: [], checks: checks({ layer3: { status: 'ok', items: { R1: { single_condition: 0.9, self_contained: 0.9, testable: 0.9, verdict: 'pass' } } } }) })
  expect(formatReport(allPass, { decision: 'write', askAllowed: true })).toContain('全部通過')
  // fail/unsure 皆已列入 open_questions → 含「全部通過」
  const asked = spec({
    open_questions: [
      { req_id: 'R1', question: 'q', options: ['a', 'b'], recommended: 0, why: 'w' },
      { req_id: 'R2', question: 'q', options: ['a', 'b'], recommended: 0, why: 'w' },
    ],
  })
  expect(formatReport(asked, { decision: 'write', askAllowed: true })).toContain('全部通過')
  expect(formatReport(spec(), { decision: 'write-final', askAllowed: true })).toContain('已達重寫上限')
  expect(formatReport(spec(), { decision: 'write', askAllowed: false })).toContain('不再提問')
})

const file = (name: string, o: Record<string, unknown>) => ({ name, text: JSON.stringify({ ...spec(), ...o }) })

test('pickActiveSpec：挑最新 confirmed', () => {
  expect(pickActiveSpec([])).toBe(null)
  expect(pickActiveSpec([file('a.json', { status: 'draft' })])).toBe(null)
  const r = pickActiveSpec([
    file('a.json', { id: 'a', status: 'confirmed', confirmed_at: '2026-10-01T00:00:00Z' }),
    file('b.json', { id: 'b', status: 'confirmed', confirmed_at: '2026-10-02T00:00:00Z' }),
    file('c.json', { id: 'c', status: 'draft', confirmed_at: '2026-10-09T00:00:00Z' }),
    file('d.json', { id: 'd', status: 'superseded', confirmed_at: '2026-10-09T00:00:00Z' }),
  ])
  expect(r?.id).toBe('b')
})

test('pickActiveSpec：壞 JSON、schema≠1、同時間取 id 大者', () => {
  const t = '2026-10-05T00:00:00Z'
  const r = pickActiveSpec([
    { name: 'bad.json', text: '{oops' },
    { name: 'null.json', text: 'null' },
    file('s2.json', { id: 'zzz', schema: 2, status: 'confirmed', confirmed_at: '2026-12-01T00:00:00Z' }),
    file('a.json', { id: 'a-1', status: 'confirmed', confirmed_at: t }),
    file('b.json', { id: 'b-1', status: 'confirmed', confirmed_at: t }),
  ])
  expect(r?.id).toBe('b-1')
  // 順序無關
  const r2 = pickActiveSpec([
    file('b.json', { id: 'b-1', status: 'confirmed', confirmed_at: t }),
    file('a.json', { id: 'a-1', status: 'confirmed', confirmed_at: t }),
  ])
  expect(r2?.id).toBe('b-1')
})

test('makeSpecId：格式、清理 slug、撞名', () => {
  const now = new Date('2026-10-13T15:30:45Z')
  expect(makeSpecId(now, 'extract-empty', new Set())).toBe('20261013-1530-extract-empty')
  expect(makeSpecId(now, 'Extract Empty!!', new Set())).toBe('20261013-1530-extract-empty')
  expect(makeSpecId(now, '../../Etc/Passwd', new Set())).toBe('20261013-1530-etc-passwd')
  expect(makeSpecId(now, '中文', new Set())).toBe('20261013-1530-spec')
  expect(makeSpecId(now, '', new Set())).toBe('20261013-1530-spec')
  expect(makeSpecId(now, 'a'.repeat(60), new Set())).toBe(`20261013-1530-${'a'.repeat(40)}`)
  const taken = new Set(['20261013-1530-x'])
  expect(makeSpecId(now, 'x', taken)).toBe('20261013-1530-x-2')
  taken.add('20261013-1530-x-2')
  expect(makeSpecId(now, 'x', taken)).toBe('20261013-1530-x-3')
  expect(makeSpecId(new Date('2026-01-02T03:04:00Z'), 'x', new Set())).toBe('20260102-0304-x')
})

test('isGuardedSpecPath', () => {
  const top = '/repo'
  expect(isGuardedSpecPath('/repo/context/specs/a.json', top)).toBe(true)
  expect(isGuardedSpecPath('/repo/context/specs/20261013-1530-x-2.json', '/repo/')).toBe(true)
  // 不分大小寫（macOS）
  expect(isGuardedSpecPath('/repo/Context/Specs/x.json', top)).toBe(true)
  expect(isGuardedSpecPath('/Repo/context/specs/x.json', top)).toBe(true)
  expect(isGuardedSpecPath('/repo/Context/Specs/sub/x.json', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/context/specs/README.md', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/context/specs/sub/a.json', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/context/specs/.json', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/context/progress.md', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/context/specs/../a.json', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/x/../context/specs/a.json', top)).toBe(false)
  expect(isGuardedSpecPath('/other/context/specs/a.json', top)).toBe(false)
  expect(isGuardedSpecPath('/repository/context/specs/a.json', top)).toBe(false)
  expect(isGuardedSpecPath('/repo/sub/context/specs/a.json', top)).toBe(false)
})
