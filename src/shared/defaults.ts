import type { WumpySettings } from './types'

export const DEFAULT_SETTINGS: WumpySettings = {
  ollamaHost: 'http://127.0.0.1:11434',

  // Opens in the light, quick mode. Toggle to dev mode for the thinking tiers.
  mode: 'quick',
  tier: 'fast',

  dock: 'right',
  tallWidth: 440,
  compactWidth: 460,
  compactHeight: 420,

  // The panel floats above everything and stays put when you click elsewhere.
  // Toggle it off with the pin button, Esc, or the hotkey.
  hideOnBlur: false,
  showReasoning: false,

  autoSave: true,
  autoCompact: true,

  // Empty on purpose: Win+C is claimed by the low-level keyboard hook (see
  // src/hook), which is the only way to get it since Windows reserves it.
  hotkeys: [],

  // Measured: a cold model load costs ~3.5s and a warm one ~8ms, which moves
  // time-to-first-word from 4.7s to 0.19s. Keeping models resident is by far
  // the largest speed lever available on CPU-only inference.
  keepAlive: '30m',
  warmOnStart: true,

  launchAtLogin: false,
  tierModels: {}
}
