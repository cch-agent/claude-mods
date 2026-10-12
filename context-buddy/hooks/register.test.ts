import { test, expect, mock } from 'claude-code/testing'

import { LINES, OPENING, REQUEST, bubbleText, buildPrompt, isWrapUp, levelOf, lineFor, parseVerdict, shouldAsk } from './register'

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
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }))
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

test('下層外掛的 AbovePrompt 被保留並與娃娃組合', {
  plugins: [{
    name: 'other-band',
    register: on => {
      on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
        const { Box, Button } = $.ui.resolve(e)
        return h(Box, {}, h(Button, { key: 'other', label: '其他', onPress: () => {} }))
      })
    },
  }],
}, async ($, on) => {
  await setup($, on, 72, () => { throw new Error('unreached') })
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'other' })).toBeDefined()
  expect(await text(ui)).toContain('ʕ')
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

const endClear = ($: any) => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
const restart = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })

test('晚到的結果：/clear（session.end reason=clear）之後丟棄', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await endClear($)
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

// ---------- 換新 session 按鈕與交接流程 ----------

const KEY = 'buddy-handoff'
const NOW = Date.UTC(2026, 9, 12, 8, 30, 15)
const PATH = '/x/.claude/handoffs/handoff-20261012T083015.md'

const restartReply = (restart: boolean) =>
  ({ value: { isAnswered: true, text: `{"restart": ${restart}, "tip": "提示"}`, usage: {} } }) as never

async function offered($: any, props: object = {}) {
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: { ...(PROPS as object), ...props } as never })
  for (let k = 0; k < 10; k++) await ui.redraw()
  const found = (await ui.find({ key: KEY })) !== undefined
  await ui.unmount()
  return found
}

test('按鈕：verdict.restart=true 顯示；prompt 要求依下一步判斷', async ($, on) => {
  let prompt = ''
  on('model.complete', (_: unknown, e: any) => {
    prompt = e.prompt
    return restartReply(true)
  })
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(true)
  expect(prompt).toContain('下一步')
})

test('按鈕：verdict.restart=false 不顯示（即使 >=75% 且收尾）', async ($, on) => {
  on('model.complete', () => restartReply(false))
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(false)
})

test('按鈕：verdict 為 null + 收尾 + >=75% 顯示後備；<75% 不顯示', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, usage: {} } }) as never)
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(true)
})

test('按鈕：後備規則在 <75% 不顯示', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 500, usage: {} } }) as never)
  await setup($, on, 74)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(false)
})

test('按鈕：詢問進行中不套用後備規則', async ($, on) => {
  deferredModel(on)
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(false)
})

test('按鈕：isWorking / hasSurvey 不顯示', async ($, on) => {
  on('model.complete', () => restartReply(true))
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(true)
  expect(await offered($, { isWorking: true })).toBe(false)
  expect(await offered($, { hasSurvey: true })).toBe(false)
})

test('按鈕：段落過後（下一個非收尾 turn）消失', async ($, on) => {
  on('model.complete', () => restartReply(true))
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(await offered($)).toBe(true)
  await $.turn.complete(turn('接下來還要處理 B。'))
  await flush()
  expect(await offered($)).toBe(false)
})

test('按鈕：晚到的 restart verdict 不會讓過期段落出現按鈕', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await $.turn.complete(turn('接下來還要處理 B。'))
  m.resolvers[0]!(restartReply(true))
  await flush()
  expect(await offered($)).toBe(false)
})

function flowSetup($: any, on: any, opts: { writeFails?: boolean; clearFails?: boolean; fillFails?: boolean; endOnClear?: boolean } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const log: string[] = []
  const fills: string[] = []
  const toasts: string[] = []
  on('model.complete', () => restartReply(true))
  on('session.cwd', () => ({ value: '/x' }) as never)
  on('prompt.submit', (_: unknown, e: any) => {
    log.push(`submit:${e.text.startsWith('請為這段對話寫') ? 'REQUEST' : 'OPENING'}`)
    return { text: e.text } as never
  })
  on('fs.write', (_: unknown, e: any) => {
    log.push(`write:${e.path}`)
    if (opts.writeFails) throw new Error('disk')
    return { value: undefined } as never
  })
  on('command.run', async (_: unknown, e: any) => {
    log.push(`command:${e.command}`)
    if (opts.clearFails) throw new Error('nope')
    if (opts.endOnClear) await endClear($) // 真實引擎的 /clear 會先觸發 session.end
    return {} as never
  })
  on('prompt.fill', (_: unknown, e: any) => {
    fills.push(e.text)
    if (opts.fillFails) throw new Error('no box')
    return { isFilled: true } as never
  })
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return { clock, log, fills, toasts }
}

async function pressButton($: any) {
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  for (let k = 0; k < 10; k++) await ui.redraw()
  await ui.press({ key: KEY })
  return ui
}

test('交接：按下送出 REQUEST 並進入 writing', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  const ui = await pressButton($)
  expect(f.log).toEqual(['submit:REQUEST'])
  for (let k = 0; k < 10; k++) await ui.redraw()
  const t = await text(ui)
  expect(t).toContain('交接：正在寫摘要')
  expect(await ui.find({ key: KEY })).toBeUndefined()
  await ui.unmount()
})

test('交接：turn.complete 存檔 → clear → submit OPENING，依序', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  const summary = '## 目前的目標\n做 X'
  await $.turn.complete(turn(summary))
  await flush()
  await f.clock.advance(300)
  await flush()
  expect(f.log).toEqual(['submit:REQUEST', `write:${PATH}`, 'command:clear', 'submit:OPENING'])
  expect(f.fills).toEqual([])
  expect(await drawn($)).not.toContain('交接：')
})

test('交接：clear 失敗退回 fill + toast', async ($, on) => {
  const f = flowSetup($, on, { clearFails: true })
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await $.turn.complete(turn('摘要內容'))
  await flush()
  await f.clock.advance(300)
  await flush()
  expect(f.log).toEqual(['submit:REQUEST', `write:${PATH}`, 'command:clear'])
  expect(f.fills).toEqual([OPENING(PATH, '摘要內容')])
  expect(f.toasts.join('\n')).toContain('自動清空失敗')
})

test('交接：存檔失敗不 clear，退回 fill + toast；fill 也失敗不丟例外', async ($, on) => {
  const f = flowSetup($, on, { writeFails: true, fillFails: true })
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await $.turn.complete(turn('摘要內容'))
  await flush()
  await f.clock.advance(300)
  await flush()
  expect(f.log).not.toContain('command:clear')
  expect(f.fills.length).toBe(1)
  expect(f.toasts.join('\n')).toContain('存檔失敗')
})

test('交接：摘要為空時中止並 toast，不 clear', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await $.turn.complete(turn('   '))
  await flush()
  await f.clock.advance(300)
  await flush()
  expect(f.log).toEqual(['submit:REQUEST'])
  expect(f.toasts.join('\n')).toContain('交接已中止')
  expect(await drawn($)).not.toContain('交接：')
})

test('REQUEST 含七個章節與路徑', () => {
  const r = REQUEST('/p.md')
  for (const h of ['目前的目標', '做完了什麼', '還沒做的', '改過哪些檔案', '要注意的地方', '可參考的檔案', '建議的下一步']) expect(r).toContain(`## ${h}`)
  expect(r).toContain('/p.md')
})

// ---------- /clear、熱重載與競態 ----------

test('/clear（session.end）於 pendingPath 期間：下一個答覆不被當成摘要', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await endClear($) // 手動 /clear：放棄這次交接
  await $.turn.complete(turn('這是一般答覆，不是摘要。'))
  await flush()
  await f.clock.advance(300)
  await flush()
  expect(f.log).toEqual(['submit:REQUEST'])
  expect(await drawn($)).not.toContain('交接：')
})

test('熱重載後 phase 殘留（閉包 pendingPath 已空）：session.start 重置為 idle', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await $.turn.complete(turn('摘要內容')) // pendingPath 已清、phase=clearing，detached 流程卡在 sleep
  await flush()
  expect(await drawn($)).toContain('交接：清空對話中')
  await restart($)
  expect(await drawn($)).not.toContain('交接：')
  void f
})

test('asking 卡 true：session.end 重置，之後可再詢問', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(1)
  expect(await offered($)).toBe(false) // asking 中不套用後備
  await endClear($)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(2)
  m.resolvers[0]!(REPLY('舊的')) // 舊詢問收尾不得動到新詢問的狀態或 verdict
  await flush()
  expect(await drawn($)).not.toContain('舊的')
  expect(await offered($)).toBe(false) // 新詢問仍進行中
})

test('asking 卡 true：session.start 重置，後備按鈕與詢問不被卡住', async ($, on) => {
  const m = deferredModel(on)
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await restart($)
  await $.turn.complete(turn('已完成。'))
  await flush()
  expect(m.calls).toBe(2)
})

test('OPENING 的 turn.complete 不被當成交接摘要（detached /clear 觸發 session.end 也無妨）', async ($, on) => {
  const f = flowSetup($, on, { endOnClear: true })
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await $.turn.complete(turn('## 摘要\n內容'))
  await flush()
  await f.clock.advance(300)
  await flush()
  expect(f.log).toContain('submit:OPENING') // session.end 的重置沒有吞掉 OPENING
  await $.turn.complete(turn('已經接續，這是 OPENING 的答覆。'))
  await flush()
  expect(f.log.filter(l => l.startsWith('write:')).length).toBe(1)
  expect(await drawn($)).not.toContain('交接：')
})

test('雙擊按鈕只送出一次 REQUEST', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 65)
  await $.turn.complete(turn('已完成。'))
  await flush()
  const ui = await $.ui.mount({ plugin: 'context-buddy', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  for (let k = 0; k < 10; k++) await ui.redraw()
  await Promise.all([ui.press({ key: KEY }), ui.press({ key: KEY })])
  await flush()
  expect(f.log.filter(l => l === 'submit:REQUEST').length).toBe(1)
  await ui.unmount()
})

test('wrapUp 在交接分支被重置：摘要答覆之後不殘留收尾狀態', async ($, on) => {
  const f = flowSetup($, on)
  await setup($, on, 80)
  await $.turn.complete(turn('已完成。'))
  await flush()
  await (await pressButton($)).unmount()
  await $.turn.complete(turn('摘要內容。')) // 這句在一般分支會被判成收尾
  await flush()
  await f.clock.advance(300)
  await flush()
  // wrapUp 若殘留 true，且 context 高於後備門檻（75%），按鈕會在無 verdict 時冒出來
  expect(await offered($)).toBe(false)
})
