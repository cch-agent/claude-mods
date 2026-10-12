import { test, expect } from 'claude-code/testing'

import { LINES, bubbleText, buildPrompt, isWrapUp, levelOf, lineFor, parseVerdict, shouldAsk } from './register'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, columns: 80, bodyColumns: 75 } as never
const EMPTY_BELOW = () => ({ type: 'Box', props: {}, children: [] }) as never

// ---------- 純規則 ----------

test('分級邊界：<40 / 40 / 60 / 75', () => {
  expect([0, 39, 40, 59, 60, 74, 75, 100].map(levelOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
})

test('台詞確定性輪替：同輸入同輸出，且會循環', () => {
  expect(lineFor(1, 4)).toBe(lineFor(1, 4))
  expect(lineFor(1, 0)).toBe(LINES[1][0])
  expect(lineFor(1, LINES[1].length)).toBe(LINES[1][0])
  expect(lineFor(3, 1)).toBe(LINES[3][1])
})

test('段落判斷：收尾字樣、待辦語氣、非 answer', () => {
  expect(isWrapUp({ reason: 'answer', answer: '已完成並 commit。' })).toBe(true)
  expect(isWrapUp({ reason: 'answer', answer: 'All done, tests pass.' })).toBe(true)
  expect(isWrapUp({ reason: 'answer', answer: '改好了 foo.ts。' })).toBe(true)
  expect(isWrapUp({ reason: 'answer', answer: '先改完 A。接下來還要處理 B。' })).toBe(false)
  expect(isWrapUp({ reason: 'answer', answer: '你想用哪一種方案？' })).toBe(false)
  // 否定的「完成」與待辦語氣優先於收尾字樣
  expect(isWrapUp({ reason: 'answer', answer: '這個功能未完成。' })).toBe(false)
  expect(isWrapUp({ reason: 'answer', answer: '測試尚未完成，還在跑。' })).toBe(false)
  expect(isWrapUp({ reason: 'answer', answer: '已完成 A，接下來還要處理 B。' })).toBe(false)
  expect(isWrapUp({ reason: 'answer', answer: '全部完成，沒有待辦。' })).toBe(true)
  expect(isWrapUp({ reason: 'answer', answer: '' })).toBe(false)
  expect(isWrapUp({ reason: 'aborted', answer: '已完成' })).toBe(false)
  expect(isWrapUp({ reason: 'error', answer: '已完成' })).toBe(false)
})

test('詢問頻率：>=50% 且距上次 >=3 個段落', () => {
  expect(shouldAsk(49, 3)).toBe(false)
  expect(shouldAsk(50, 2)).toBe(false)
  expect(shouldAsk(50, 3)).toBe(true)
  expect(shouldAsk(90, 5)).toBe(true)
})

test('提示詞：答覆截到 800 字且含百分比與 JSON 格式要求', () => {
  const p = buildPrompt('Z'.repeat(2000), 63.4)
  expect(p).toContain('63%')
  expect(p).toContain('"restart"')
  expect(p.split('Z').length - 1).toBe(800)
})

test('JSON 解析：正常、包在 code fence、超長 tip 截斷', () => {
  expect(parseVerdict('{"restart": true, "tip": "換新主題了"}')).toEqual({ restart: true, tip: '換新主題了' })
  expect(parseVerdict('```json\n{"restart": false, "tip": "可繼續"}\n```')).toEqual({ restart: false, tip: '可繼續' })
  const long = parseVerdict(`{"restart": false, "tip": "${'字'.repeat(50)}"}`)
  expect(long?.tip.length).toBe(30)
})

test('JSON 解析：壞資料一律回 null', () => {
  for (const bad of ['', 'nope', '{', '{"restart": "yes", "tip": "x"}', '{"restart": true}', '{"restart": true, "tip": ""}', '[1,2]', null, undefined, 42]) {
    expect(parseVerdict(bad as never)).toBeNull()
  }
})

test('泡泡文字：模型判斷優先，restart 加上建議', () => {
  expect(bubbleText({ pct: 80, tick: 0, wrapUp: false, verdict: { restart: true, tip: '新模組' } })).toBe('新模組（建議 /clear 或開新 session）')
  expect(bubbleText({ pct: 55, tick: 0, wrapUp: false, verdict: { restart: false, tip: '繼續' } })).toBe('繼續')
  expect(bubbleText({ pct: 10, tick: 1, wrapUp: false, verdict: null })).toBe(LINES[0][1])
})

// ---------- 引擎整合 ----------

function setup($: any, on: any, percent: number, below: () => unknown = EMPTY_BELOW) {
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000, percent }, rateLimits: [] } }) as never)
  on('ui.render', below)
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  return $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
}

const turn = (answer: string, extra: object = {}) =>
  ({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', ...extra }) as never

async function text(ui: any) {
  return JSON.stringify(await ui.drawn())
}

test('渲染：低 context 顯示平靜台詞與百分比', async ($, on) => {
  await setup($, on, 20)
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const t = await text(ui)
  expect(t).toContain(LINES[0][0])
  expect(t).toContain('context')
  expect(t).toContain('20')
  await ui.unmount()
})

test('渲染：hasSurvey 讓位、isWorking 顯示工作中', async ($, on) => {
  await setup($, on, 20, () => ({ type: 'Box', props: {}, children: ['SURVEY'] }) as never)
  const survey = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), hasSurvey: true } as never })
  const t1 = await text(survey)
  expect(t1).toContain('SURVEY')
  expect(t1).not.toContain('ʕ')
  await survey.unmount()

  const busy = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), isWorking: true } as never })
  expect(await text(busy)).toContain('工作中')
  await busy.unmount()
})

test('渲染：娃娃列數不超過 maxRows', async ($, on) => {
  await setup($, on, 20)
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), maxRows: 1 } as never })
  const t = await text(ui)
  expect(t).toContain('ʕ')
  expect(t).not.toContain('context')
  await ui.unmount()
})

test('與 handoff-button 共存：下層外掛的按鈕被保留並加上交接提示', {
  plugins: [{
    name: 'handoff-button',
    register: on => {
      on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
        const { Box, Button } = $.ui.resolve(e)
        return h(Box, {}, h(Button, { key: 'handoff', label: '交接', onPress: () => {} }))
      })
    },
  }],
}, async ($, on) => {
  await setup($, on, 72, () => { throw new Error('unreached') })
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
  expect(await text(ui)).toContain('可按『交接』')
  await ui.unmount()
})

test('段落結束 + 模型回 JSON：泡泡顯示 tip 與重開建議', async ($, on) => {
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '{"restart": true, "tip": "新主題，換個對話"}', usage: {} } } as never
  })
  await setup($, on, 65)
  await $.turn.complete(turn('全部完成，已 commit。'))
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  let t = ''
  for (let i = 0; i < 20 && !t.includes('新主題'); i++) {
    await ui.redraw()
    t = await text(ui)
  }
  expect(calls).toBe(1)
  expect(t).toContain('新主題，換個對話')
  expect(t).toContain('建議 /clear 或開新 session')
  await ui.unmount()
})

for (const [name, reply] of [
  ['壞資料（非 JSON）', { isAnswered: true, text: '我覺得不用重開', usage: {} }],
  ['aborted', { isAnswered: false, reason: 'aborted', usage: {} }],
  ['api-error', { isAnswered: false, reason: 'api-error', status: 500, usage: {} }],
] as const) {
  test(`模型${name}：退回本地規則，不丟例外`, async ($, on) => {
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return { value: reply } as never
    })
    await setup($, on, 65)
    await $.turn.complete(turn('已完成。'))
    const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    for (let k = 0; k < 10; k++) await ui.redraw()
    expect(calls).toBe(1)
    expect(await text(ui)).toContain('這段告一段落了，適合現在收尾。')
    await ui.unmount()
  })
}

test('模型呼叫丟例外：退回本地規則', async ($, on) => {
  on('model.complete', () => {
    throw new Error('boom')
  })
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  for (let k = 0; k < 10; k++) await ui.redraw()
  expect(await text(ui)).toContain('這段告一段落了，適合現在收尾。')
  await ui.unmount()
})

test('subagent 的 turn.complete 與非 answer 不觸發模型', async ($, on) => {
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '{"restart": false, "tip": "x"}', usage: {} } } as never
  })
  await setup($, on, 80)
  await $.turn.complete(turn('已完成', { agentId: 'sub-1' }))
  await $.turn.complete(turn('已完成', { reason: 'aborted', isAborted: true }))
  for (let k = 0; k < 10; k++) await Promise.resolve()
  expect(calls).toBe(0)
})

// ---------- 節流、過期與提示 ----------

const REPLY = (tip: string) => ({ value: { isAnswered: true, text: `{"restart": true, "tip": "${tip}"}`, usage: {} } }) as never

async function flush(n = 20) {
  for (let k = 0; k < n; k++) await Promise.resolve()
}

function deferredModel(on: any) {
  const state = { calls: 0, resolvers: [] as ((v: unknown) => void)[] }
  on('model.complete', () => {
    state.calls += 1
    return new Promise(res => state.resolvers.push(res))
  })
  return state
}

async function drawn($: any) {
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  for (let k = 0; k < 10; k++) await ui.redraw()
  const t = await text(ui)
  await ui.unmount()
  return t
}

test('節流：連續多個收尾段落只呼叫模型 1 次', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 65)
  for (let i = 0; i < 3; i++) await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(1)
})

test('節流：詢問進行中不重入，結束後才可再問', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 65)
  for (let i = 0; i < 4; i++) await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(1) // 第 4 段已達間隔，但仍在詢問中
  m.resolvers[0]!(REPLY('甲'))
  await flush()
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(2)
})

test('<50% 不詢問', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 49)
  for (let i = 0; i < 5; i++) await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(0)
})

test('晚到的結果：/clear（session.start）之後丟棄', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  m.resolvers[0]!(REPLY('過期提示'))
  await flush()
  expect(await drawn($)).not.toContain('過期提示')
})

test('晚到的結果：新一輪非收尾段落之後丟棄', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await $.turn.complete(turn('接下來還要處理 B。'))
  m.resolvers[0]!(REPLY('過期提示'))
  await flush()
  expect(await drawn($)).not.toContain('過期提示')
})

test('verdict 只對發出詢問的段落有效：下一個收尾段落不沿用舊 tip', async ($, on) => {
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return REPLY('舊提示')
  })
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await drawn($)).toContain('舊提示')
  await $.turn.complete(turn('又完成了。')) // 間隔未到，不詢問
  await flush()
  expect(calls).toBe(1)
  const t = await drawn($)
  expect(t).not.toContain('舊提示')
  expect(t).toContain('這段告一段落了，適合現在收尾。')
})

test('交接提示：下層是「清空對話中…」文字（無 handoff 按鈕）時不附加', {
  plugins: [{
    name: 'other-band',
    register: on => {
      on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        return h(Box, {}, h(Text, {}, '清空對話中…'))
      })
    },
  }],
}, async ($, on) => {
  await setup($, on, 72, () => { throw new Error('unreached') })
  const t = await drawn($)
  expect(t).toContain('清空對話中')
  expect(t).not.toContain('可按『交接』')
})
