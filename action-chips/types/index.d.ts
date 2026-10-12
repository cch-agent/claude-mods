/** 一個小框：open 開啟檔案或網址，copy 複製指令。 */
export type Chip = { kind: 'open' | 'copy'; target: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'action-chips': { chips: Chip[] }
  }
}
