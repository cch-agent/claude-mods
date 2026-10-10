export type HandoffPhase = 'idle' | 'writing' | 'clearing'

declare module 'claude-code' {
  interface PluginState {
    'handoff-button': { percent: number; phase: HandoffPhase }
  }
}
