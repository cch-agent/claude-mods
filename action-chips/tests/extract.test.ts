import { expect, test } from 'claude-code/testing'

import { extract, fallbackLabel, parseLabels } from '../hooks/extract'

test('依出現順序抽出網址、檔案與指令，去掉重複與行號', async () => {
  const text = [
    '比較頁：https://claude.ai/artifact/We7X5pnQt8L4fxBGoBw1vD',
    '改了 `apps/web/src/lib/theme.css:12` 與 [進度](context/progress.md)。',
    '請執行：',
    '```',
    '! cd apps/web && pnpm build && npx wrangler deploy',
    '```',
    '再看一次 `apps/web/src/lib/theme.css`，以及 `pnpm test` 不是路徑。',
  ].join('\n')
  const got = extract(text).map(c => [c.kind, c.target])
  expect(got).toEqual([
    ['open', 'https://claude.ai/artifact/We7X5pnQt8L4fxBGoBw1vD'],
    ['open', 'apps/web/src/lib/theme.css'],
    ['open', 'context/progress.md'],
    ['copy', '! cd apps/web && pnpm build && npx wrangler deploy'],
  ])
})

test('非 shell 的 code fence 不算指令，inline 的 ! 指令算', async () => {
  const got = extract('```ts\nconst a = 1\n```\n跑 `! git status` 看看')
  expect(got.map(c => c.target)).toEqual(['! git status'])
})

test('備用標籤與模型標籤解析', async () => {
  expect(fallbackLabel({ kind: 'open', target: '/a/b/theme.css' })).toBe('theme.css')
  expect(fallbackLabel({ kind: 'copy', target: '! git status' })).toBe('git status')
  expect(parseLabels('好的：["web demo","部署指令"]', 2)).toEqual(['web demo', '部署指令'])
  expect(parseLabels('["只有一個"]', 2)).toBeUndefined()
})

test('review 邊界：中文緊接網址、括號、無語言 fence、行號格式', async () => {
  expect(extract('看 https://a.com/x打開').map(c => c.target)).toEqual(['https://a.com/x'])
  expect(extract('「https://b.com/y」').map(c => c.target)).toEqual(['https://b.com/y'])
  expect(extract('(見 https://w.org/Foo_(bar))').map(c => c.target)).toEqual(['https://w.org/Foo_(bar)'])
  expect(extract('[z](https://a.com/(x))').map(c => c.target)).toEqual(['https://a.com/(x)'])
  expect(extract('```\nsrc/\n├── a\n```')).toEqual([])
  expect(extract('```console\n$ ls\nfile.txt\n```').map(c => c.target)).toEqual(['ls'])
  expect(extract('`src/a.ts:12-20` `b.md#sec`').map(c => c.target)).toEqual(['src/a.ts', 'b.md'])
})
