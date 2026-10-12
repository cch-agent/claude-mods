export type BuddyVerdict = { restart: boolean; tip: string }
export type HandoffPhase = 'idle' | 'writing' | 'clearing'

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
      /** 換新 session 的交接流程階段 */
      phase: HandoffPhase
      /** 小模型詢問進行中（此時不套用後備按鈕規則） */
      asking: boolean
    }
  }
}
