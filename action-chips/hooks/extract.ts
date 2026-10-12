import type { Chip } from '../types'

/** 抽出的候選：path 型的還要確認檔案存在才算數。 */
export type Candidate = { kind: 'open' | 'copy'; target: string; isPath: boolean }

const SHELL_LANGS = new Set(['sh', 'bash', 'zsh', 'shell', 'console'])
// 沒標語言的 code fence，第一行要像指令才算
const CMD_HEAD = /^(!|cd|pnpm|npm|npx|yarn|bun|git|gh|claude|node|python3?|pip|curl|brew|wrangler|make|ls|cat|open|docker|kubectl)(\s|$)/
// 網址只收 ASCII，遇到中文或全形標點就停
const URL_RE = /https?:\/\/[\x21-\x7e]+/g

/** 去掉網址結尾的標點與不成對的右括號。 */
export function trimUrl(u: string): string {
  let s = u.replace(/[.,:;!?'"`>\]]+$/, '')
  while (s.endsWith(')') && (s.match(/\(/g) ?? []).length < (s.match(/\)/g) ?? []).length) {
    s = s.slice(0, -1).replace(/[.,:;!?'"`]+$/, '')
  }
  return s
}

function looksLikePath(s: string): boolean {
  if (/\s/.test(s) || s.startsWith('-') || s.includes('://')) return false
  if (/^[\w.-]+\(\)$/.test(s)) return false // 函式名
  return s.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(s)
}

/** 去掉 `file.ts:12` 這類行號。 */
export function stripLine(s: string): string {
  return s.replace(/(?::\d+(?:[-:]\d+)*|#L?\d+.*|#[\w-]+)$/, '')
}

/** 依出現順序抽出回覆中的指令、檔案路徑與網址，重複的只留第一個。 */
export function extract(text: string): Candidate[] {
  const found: { at: number; c: Candidate }[] = []
  let rest = text

  // 1. code fence：shell 類的整塊當一個指令
  rest = rest.replace(/```([\w-]*)[^\n]*\n([\s\S]*?)```/g, (m, lang: string, body: string, at: number) => {
    const l = lang.toLowerCase()
    let lines = body.split('\n').map(x => x.trimEnd())
    if (l === 'console') lines = lines.filter(x => x.startsWith('$ '))
    const cmd = lines
      .map(x => x.replace(/^\$ /, ''))
      .filter(x => x.trim() !== '' && !x.trimStart().startsWith('#'))
      .join('\n')
    if (cmd && (SHELL_LANGS.has(l) || (l === '' && CMD_HEAD.test(cmd)))) {
      found.push({ at, c: { kind: 'copy', target: cmd, isPath: false } })
    }
    return ' '.repeat(m.length)
  })

  // 2. markdown 連結
  rest = rest.replace(/\[[^\]\n]*\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, href: string, at: number) => {
    if (/^https?:\/\//.test(href)) found.push({ at, c: { kind: 'open', target: href, isPath: false } })
    else if (looksLikePath(stripLine(href))) found.push({ at, c: { kind: 'open', target: stripLine(href), isPath: true } })
    return ' '.repeat(m.length)
  })

  // 3. inline code：`! cmd` 是指令，像路徑的是檔案
  rest = rest.replace(/`([^`\n]+)`/g, (m, code: string, at: number) => {
    const s = code.trim()
    if (/^!\s*\S/.test(s)) found.push({ at, c: { kind: 'copy', target: s, isPath: false } })
    else if (/^https?:\/\//.test(s)) found.push({ at, c: { kind: 'open', target: s, isPath: false } })
    else if (looksLikePath(stripLine(s))) found.push({ at, c: { kind: 'open', target: stripLine(s), isPath: true } })
    return ' '.repeat(m.length)
  })

  // 4. 裸網址
  for (const m of rest.matchAll(URL_RE)) {
    found.push({ at: m.index ?? 0, c: { kind: 'open', target: trimUrl(m[0]), isPath: false } })
  }

  found.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const { c } of found) {
    const key = c.kind + '\0' + c.target
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/** 模型沒給標籤時的備用：檔名、網址的主機與路徑、指令的開頭。 */
export function fallbackLabel(c: Pick<Chip, 'kind' | 'target'>): string {
  if (c.kind === 'copy') {
    const first = (c.target.split('\n')[0] ?? '').replace(/^!\s*/, '')
    return first.length > 28 ? first.slice(0, 27) + '…' : first
  }
  if (/^https?:\/\//.test(c.target)) {
    try {
      const u = new URL(c.target)
      const p = u.pathname.split('/').filter(Boolean).at(-1)
      return p ? `${u.hostname.split('.')[0]}/${p.slice(0, 12)}` : u.hostname
    } catch {
      return c.target.slice(0, 28)
    }
  }
  return c.target.split('/').filter(Boolean).at(-1) ?? c.target
}

/** 從模型回覆中取出 JSON 字串陣列；取不到回 undefined。 */
export function parseLabels(reply: string, n: number): string[] | undefined {
  const m = reply.match(/\[[\s\S]*\]/)
  if (!m) return undefined
  try {
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr) || arr.length !== n) return undefined
    return arr.map(x => (typeof x === 'string' ? x.trim().slice(0, 24) : ''))
  } catch {
    return undefined
  }
}
