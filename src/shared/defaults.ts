import type { WumpySettings } from './types'
import { DEFAULT_MODEL } from './assistant'
import { DEFAULT_ENGINE } from './links'
import { DEFAULT_ORDERING } from './order'

export const DEFAULT_SETTINGS: WumpySettings = {
  // The one model. Chosen by measurement, not by name - see assistant.ts.
  model: DEFAULT_MODEL,

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

  // Costs CPU during generation, which is the worst moment to spend it.
  smoothText: false,

  // A hosted model that has not started in three minutes is not going to.
  maxTurnMs: 180_000,

  launchAtLogin: false,

  // Commands are never run without an explicit click, so this gates whether
  // the model may even propose them.
  shellEnabled: true,
  shellCwd: '',

  // Nothing runs unasked until the user says otherwise.
  approvalMode: 'manual',
  confirmRisky: true,

  // Off: reasoning is spent before the first visible word, so it is paid
  // on every turn including the ones that are just chat. `/think` is one
  // word away when a question deserves it.
  thinking: false,

  // Keyless search answers encyclopedic questions. Add a Brave key for general
  // web results; nothing else in Wumpy needs an account.
  searchEnabled: true,
  searchApiKey: '',

  // Empty means every provider's keys share one allowance, which is true of
  // all of them but Google and is the safe half of the guess. See
  // WumpySettings.keyAccounts.
  keyAccounts: {},

  // Empty until `/model check` has run once, which is the honest starting
  // state: the catalogue's own figures are all anyone has measured here.
  latencies: {},

  // Better another model than none, so long as the answer says which it is.
  apiFallback: true,
  // Off until asked for with /voice. It is not only a microphone button: with it
  // on, holding the spacebar means something, and the most-pressed key on the
  // keyboard does not change behaviour because an app was installed.
  voiceEnabled: false,
  // Off by default now. Polishing used to be guaranteed local; without Ollama
  // it sends what you dictated to the provider, which is a different bargain
  // and should be opted into rather than inherited.
  voicePolish: false,
  voiceAutoStop: true,
  voiceCloud: true,
  speakVoice: 'Magpie-Multilingual.EN-US.Aria',
  pauseMusic: true,
  reflect: false,
  reflectRounds: 3,
  reflectModel: '',

  // Off: the saving is large and measured, the shorter wording is not. The
  // full text is what is known to work on this model. See WumpySettings.
  leanPrompt: false,

  /* False so an existing settings file is migrated once; a fresh install
     starts on DEFAULT_MODEL anyway and the migration finds nothing to do. */
  movedOffGoogle: false,

  // Opening a page is allowed to be proposed; whether it happens without a click
  // depends on the approval mode, the same way a command does.
  browserEnabled: true,
  screenEnabled: true,
  // Which engine a `search:` opens. Asked for: "I prefer google". The reasoning
  // for this and for every other engine lives next to DEFAULT_ENGINE, including
  // why the in-panel `wumpy-search` still queries DuckDuckGo whatever this says.
  searchEngine: DEFAULT_ENGINE,

  // Which way the model list is sorted. Balanced is the recommendation and
  // is what the single order used to approximate; the other two tabs answer
  // a narrower question. See @shared/order for all three and their captions.
  modelOrder: DEFAULT_ORDERING,

  // See WumpySettings.autoRank. On, and inert without a second key.
  autoRank: true
}
