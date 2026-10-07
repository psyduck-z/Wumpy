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

  // Costs CPU during generation, which is the worst moment to spend it.
  smoothText: false,

  // Measured: qwen3:4b spent 9m37s reasoning about a single question. At ~5
  // tok/s on CPU there is no answer worth waiting longer than this for.
  maxTurnMs: 180_000,

  launchAtLogin: false,

  // Commands are never run without an explicit click, so this gates whether
  // the model may even propose them.
  shellEnabled: true,
  shellCwd: '',

  // Nothing runs unasked until the user says otherwise.
  approvalMode: 'manual',
  confirmRisky: true,

  // Keyless search answers encyclopedic questions. Add a Brave key for general
  // web results; nothing else in Wumpy needs an account.
  searchEnabled: true,
  searchApiKey: '',

  tierModels: {},
  // On, but the button only appears once a transcriber is actually found, so
  // this is the switch for not wanting one rather than for not having one.
  voiceEnabled: true,
  voiceModel: 'base.en',
  voicePolish: true,
  voiceAutoStop: true,

  // Opening a page is allowed to be proposed; whether it happens without a click
  // depends on the approval mode, the same way a command does.
  browserEnabled: true,
  // DuckDuckGo because it needs no account and does not follow you, which is the
  // same reason the in-panel search falls back to it.
  searchEngine: 'duckduckgo'
}
