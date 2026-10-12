export type BuddyVerdict = { restart: boolean; tip: string }

declare module 'claude-code' {
  interface PluginState {
    'context-buddy': {
      percent: number
      /** 每次資料更新 +1，台詞用它確定性輪替 */
      tick: number
      /** 最近一次段落是否看起來可收尾 */
      wrapUp: boolean
      /** 模型（或 null）給的判斷 */
      verdict: BuddyVerdict | null
    }
  }
}
