import type { WumpySettings } from './types'

export const DEFAULT_SETTINGS: WumpySettings = {
  ollamaHost: 'http://127.0.0.1:11434',
  // Non-reasoning on purpose. On CPU-only inference a reasoning model such as
  // qwen3:4b spends 20-35s on scratchpad before its first visible word, which
  // is unusable for an overlay you summon mid-task. Swap it in the header
  // dropdown when you want depth over speed.
  chatModel: 'llama3.2:3b',
  systemPrompt: [
    'You are Wumpy, a local assistant living in the Windows system tray.',
    'You are terse by default: answer in as few words as the question allows.',
    'Use markdown for structure and fenced code blocks with a language tag for code.',
    'You run entirely on the user’s machine, so never claim you cannot access local context — ask for it instead.'
  ].join(' '),
  // Empty on purpose: Win+C is claimed by the low-level keyboard hook (see
  // src/hook), which is the only way to get it since Windows reserves it.
  // Add Electron accelerators here if you want extra keys alongside it.
  hotkeys: [],
  hideOnBlur: true,
  thinking: false,
  panelWidth: 440,
  launchAtLogin: false
}
