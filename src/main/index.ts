import { app, clipboard, dialog, ipcMain, nativeImage, session, Tray } from 'electron'
import { cpus, homedir } from 'node:os'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPC } from '@shared/types'
import type {
  Attachment,
  ChatMessage,
  CommandVerdict,
  ShellKind,
  ShellResult,
  ChatRequest,
  ChatSummary,
  Dock,
  HotkeyState,
  Assistant,
  AssistantStatus,
  UsageReport,
  WumpySettings
} from '@shared/types'
import { DEFAULT_MODEL, assistantFor, assemblePrompt, type PromptShape } from '@shared/assistant'
import type { Footprint } from '@shared/footprint'
import type { RankView, Transcript, VoiceStatus } from '@shared/types'
import { Ranker } from './ranker'
import { SettingsStore } from './store'
import { capDiskCache, reclaimCache } from './disk'
import { ChatStore } from './chats'
import { InputHistory } from './history'
import { CloudClient, requestsInLastMinute, sinceLimited, whenLimited } from './cloud'
import { KeyStore } from './keys'
import { JournalStore } from './journal'
import {
  diffSettings,
  modelLabel,
  rankNote,
  sweepLine,
  sweepOpen,
  type Entry
} from '@shared/journal'
import { UsageStore } from './usage'
import { PoolStore } from './pool'
import { perKeyCapFor } from '@shared/usage'
import { DEFAULT_RUNS, freshLatencies, spent, usable } from '@shared/probe'
import { lookAtFile } from './look'
import { needsFor, type Capability } from '@shared/needs'
import { trimPictures } from '@shared/pressure'
import { Panel } from './panel'
import { createTray, resourcePath } from './tray'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { LowLevelHook } from './lowlevelhook'
import { runCommand, assessRisk, isReadOnly, riskLevel } from './shell'
import { PriorityManager } from './priority'
import { webSearch } from './search'
import { cleanTitle, titleBrief, titleSource } from '@shared/titles'
import { folderFacts, resolveUserFolders } from './folders'
import { ContextStore } from './context'
import { Speech } from './speech'
import {
  DEFAULT_VOICE,
  TTS_RATE,
  closeSpeech,
  coldSpeech,
  pcmFromWav,
  primeHearing,
  primeTalking,
  recognize,
  synthesize,
  synthesizeStream,
  warmSpeech,
  wavFrom
} from './nvspeech'
import { VOICE_FIRST_TOKEN_MS, quickerModel } from '@shared/voicequick'
import { holdMusic, releaseAllMusic, releaseMusic } from './music'
import { MENTOR_PROMPT, parseReview, type ReflectReview } from '@shared/reflect'
import { openLink, openSearch } from './browser'
import { inspectWriteTarget, writeProposedFile } from './writefile'
import { runPlan, visibleElements } from './input'
import { readPlan } from '@shared/steps'
import {
  PROVIDERS,
  eyeReady,
  isCloudModel,
  isProviderId,
  looksLikeKey,
  PROVIDER_IDS,
  budgetsFor,
  providerFor,
  seesMedia,
  siblingModel
} from '@shared/cloud'
import type { CloudModel, ProviderId } from '@shared/cloud'
import { checkLink, DEFAULT_ENGINE, isSearchEngine } from '@shared/links'
import { POLISH_PROMPT, polishAcceptable, tidyTranscript } from '@shared/dictation'
import { captureConsole, log, logPath } from './log'
import { captureScreen } from './screen'

/**
 * Before anything else, so that whatever happens during startup is readable.
 *
 * `npm run restart` has to detach the process, which means stdio is thrown
 * away and every console line with it. See log.ts.
 */
captureConsole()
console.log(`[wumpy] started; log at ${logPath()}`)

/**
 * Only one Wumpy may own the tray icon and the global hotkey.
 *
 * The lock is taken here, at module scope, and the answer is kept - because
 * app.quit() does not stop this file. It asks the event loop to shut down and
 * returns, and everything below it goes on running: the ready handler is
 * registered, and if it fires before the shutdown completes a second Wumpy
 * builds a window and shows it, for as long as it takes to die.
 *
 * Which is one of the two things the user described as a flash: open a second
 * copy and you get its window briefly, then its death, then the first copy's
 * window from the second-instance handler. Open, shut, open.
 *
 * So the bootup below is guarded on this rather than on nothing.
 */
const isPrimary = app.requestSingleInstanceLock()
if (!isPrimary) {
  console.log('[wumpy] another Wumpy already has the lock; handing over and quitting')
  /**
   * exit(), not quit(), and the difference is visible.
   *
   * quit() asks the event loop to wind down, which took about a second -
   * measured at +942ms, a whole second of a second Wumpy sitting there
   * owning nothing. When it finally went, Windows reassigned the foreground
   * and the panel that had just been summoned lost the keyboard: you clicked
   * the shortcut, the panel opened and focused, and a second later you had
   * to click the box to type.
   *
   * There is nothing to wind down. The lock was refused, so the guard below
   * means this process never built a window, never registered a hotkey and
   * never started the keyboard helper. The handover has already happened:
   * requestSingleInstanceLock delivers 'second-instance' to the primary
   * before it returns, which is why the primary's show() is logged ~9ms
   * after this process started and 90ms before this line could matter.
   */
  app.exit(0)
}

app.setAppUserModelId('dev.psyduckz.wumpy')
/*
 * Linux: keys are encrypted by the desktop keyring. Chromium only picks it
 * when it recognises the desktop, and it does not recognise Hyprland - so it
 * would fall back to storing nothing safely, and the key store would refuse
 * every key. Omarchy runs gnome-keyring, so ask for it by name.
 */
if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
/* Before anything opens the cache, which is why it is here and not in the
   ready handler: see @main/disk, where the 26 MB came from. */
capDiskCache()
// Registering any handler here overrides Electron's quit-on-last-window
// behaviour, which is what keeps Wumpy alive in the tray with no window open.
app.on('window-all-closed', () => {})

let settings: SettingsStore
let chats: ChatStore
let inputHistory: InputHistory
let cloud: CloudClient
let keys: KeyStore
let notes: ContextStore
let usage: UsageStore
let pools: PoolStore
let ranker: Ranker
/**
 * What Wumpy has done, with the time. Read by `/log`.
 *
 * In this process because the interesting things happen with no window
 * watching: the hourly ranking, the tray menu, a provider's refusal. See
 * @shared/journal.
 */
let journal: JournalStore
/**
 * When the turn the user is waiting on started, and when the last one ended.
 *
 * Only the background ranker reads these, and only to get out of the way.
 * Module scope rather than inside the handler because the ranker ticks on
 * its own timer and has to be able to ask at any moment.
 */
let turnStartedAt: number | null = null
let lastTurnEndedAt = 0
/**
 * Hosted models that have said they are out for the day.
 *
 * Google's allowance is per model, so one running out says nothing about the
 * next; this is only here so a spent model is not tried again and again on
 * every turn. Cleared when the process restarts, which is near enough to
 * daily for something that costs one wasted request to be wrong about.
 */
const spentToday = new Set<string>()
let panel: Panel
let tray: (Tray & { refresh(): void }) | null = null
let hotkeyState: HotkeyState = { active: null, failed: [], intercepted: null }
let lowLevelHook: LowLevelHook | null = null
let priority: PriorityManager
let speech: Speech

/** Hosted speech is used whenever an NVIDIA key exists (see nvspeech.ts). */
function cloudSpeech(): boolean {
  return settings.get('voiceCloud') !== false && keys.available() && keys.has('nvidia')
}

/**
 * Ready when either way of hearing is: Parakeet with a key, or Whisper.
 *
 * When neither is, the reason names the easy way first. Whisper's own reason
 * is about a Python environment, which is true and is the last thing someone
 * holding the spacebar wants to read: what they are missing is a key, and
 * the key they already have for chat is the one that hears them too.
 */
function voiceStatus(): VoiceStatus {
  if (cloudSpeech()) return { kind: 'ready', model: 'NVIDIA Parakeet', loadMs: 0 }
  const local = speech.status()
  if (local.kind !== 'absent') return local
  const why =
    settings.get('voiceCloud') === false
      ? 'Hosted speech is turned off in settings, and'
      : keys.has('nvidia')
        ? 'The key store is locked, and'
        : 'Talking needs an NVIDIA key - add one with /key nvidia <key> - or'
  return {
    kind: 'absent',
    detail: `${why} there is no local transcriber (npm run speech:install sets one up).`
  }
}

/**
 * One clip to text: Parakeet first when it can be used, Whisper otherwise
 * and whenever Parakeet fails, so a network blip costs accuracy, not the turn.
 */
async function hear(audio: Uint8Array, extension: string): Promise<Transcript> {
  if (cloudSpeech() && extension === 'wav') {
    const borrowed = await cloud.speechKey('parakeet')
    if (borrowed) {
      try {
        return await recognize(audio, borrowed)
      } catch (err) {
        console.warn('[wumpy] Parakeet could not hear that, trying Whisper:', err)
      }
    }
  }
  return speech.transcribe(audio, extension)
}

/* --------------------------------------------------------- the assistant */

/**
 * The model that answers, and whether it can.
 *
 * One model now, so this is a setting and a key check rather than a search
 * through what is installed locally. It still returns null rather than a
 * name it cannot use, so the status bar can say why instead of the first
 * question failing at send time.
 */
function activeModel(): string {
  const chosen = settings.get('model')
  return chosen && isCloudModel(chosen) ? chosen : DEFAULT_MODEL
}

/**
 * The one-time move off Google, when it left the picker.
 *
 * `providerFor` still routes `gemini-*`, deliberately - a name typed by hand
 * has always worked and still should. The cost of that is a settings file
 * holding gemini-3.1-flash-lite, which answers perfectly well, so removing
 * Google from the list would have changed nothing for the one person whose
 * settings already named one.
 *
 * Once, therefore, and remembered: a user who later types a Gemini name on
 * purpose keeps it through every restart after this.
 */
function moveOffGoogle(): void {
  if (settings.get('movedOffGoogle')) return
  const chosen = settings.get('model')
  const wasGoogle = chosen ? providerFor(chosen) === 'google' : false
  settings.patch({ movedOffGoogle: true, ...(wasGoogle ? { model: DEFAULT_MODEL } : {}) })
  if (wasGoogle) {
    console.log(`[wumpy] moved off ${chosen}: Google is no longer offered, now ${DEFAULT_MODEL}`)
  }
}

function resolveModel(): string | null {
  const model = activeModel()
  return cloud?.ready(model).ok ? model : null
}

function assistantStatus(): AssistantStatus {
  const model = activeModel()
  const check = cloud?.ready(model)
  return { model, ready: Boolean(check?.ok), why: check?.ok ? '' : (check?.why ?? 'No key yet.') }
}

/**
 * A model for background work: titling, compaction, polishing a transcript.
 *
 * This used to be pinned to a local model however the tiers were set, for
 * three reasons that are worth keeping on the record now that it cannot be.
 *
 * Budget: each is a whole extra request, and Google's free tier counts
 * requests - about 25 a day on the newest Flash, measured by exhausting one.
 * Privacy: compaction sends the whole conversation, which by then may hold
 * command output and the contents of files, to a tier that trains on what it
 * is sent. Reliability: they run while the user is reading, so a rate limit
 * there must never surface as a failure.
 *
 * Only the first and third are still answerable. Codestral's free tier counts
 * tokens a minute rather than requests a day and reports 125 requests a
 * minute, so the budget argument is gone; a failed background call still
 * returns null and the caller carries on. The privacy one simply no longer
 * has an answer, which is the real cost of removing the local path.
 */
function backgroundModel(): string | null {
  return resolveModel()
}

/**
 * Which keyless providers' daemons are answering on this machine.
 *
 * Ollama has no key, so "configured" could never say whether it was there,
 * and everything treated it as ready the moment it was named. On a machine
 * without Ollama that meant the Gemma row was pickable, recommended in the
 * spoken shortlist, and probed by the ranker - and then every message to it
 * failed to connect. So it is asked: its OpenAI-style /models, on localhost,
 * at startup and every half minute after. Nothing listening is a refused
 * connection and costs nothing; a request about to be sent asks again
 * rather than trusting a stale "no" (CloudClient.freshLocal).
 */
const localUp = new Set<ProviderId>()
let localChecking: Promise<void> | null = null

function checkLocal(): Promise<void> {
  localChecking ??= (async () => {
    let changed = false
    for (const id of PROVIDER_IDS) {
      if (!PROVIDERS[id].keyless) continue
      const up = await fetch(`${PROVIDERS[id].base}/models`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.ok)
        .catch(() => false)
      if (up === localUp.has(id)) continue
      changed = true
      if (up) localUp.add(id)
      else localUp.delete(id)
      console.log(`[wumpy] ${PROVIDERS[id].label} ${up ? 'is answering' : 'stopped answering'} on this machine`)
    }
    if (changed && panel) await refreshModels()
  })().finally(() => {
    localChecking = null
  })
  return localChecking
}

async function refreshModels(): Promise<void> {
  panel.send(IPC.assistantStatus, assistantStatus())
  tray?.refresh()
}

/**
 * The day's quota, but only when it is worth a sentence.
 *
 * Normally nothing, which is the point: this block is placed just behind the
 * user's latest turn and a line that changes every time is a line that can
 * never be cached. A count of requests remaining would do exactly that and
 * buy nothing - the model cannot act on 474 any differently from 473.
 *
 * What it cannot work out for itself is that something is running out. So
 * the line appears when a key has died or the pool is down to its last
 * quarter, and says what that means for the next few turns.
 */
function quotaFacts(): string[] {
  const model = activeModel()
  const provider = providerFor(model)
  if (!provider) return []
  const pool = cloud.poolFor(model, perKeyCapFor(usage.today(), model, provider))
  if (!pool || pool.keys === 0) return []

  const low = pool.remaining !== null && pool.cap > 0 && pool.remaining <= pool.cap * 0.25
  if (!low && pool.spent === 0 && pool.ready > 0) return []

  const back = new Date(pool.resetAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
  if (pool.ready === 0) {
    return [
      `- Today's free allowance for ${model} is gone on all ${pool.keys} keys; ` +
        `it comes back at ${back}. Another model may still have some.`
    ]
  }
  return [
    `- Free allowance for ${model}: ${pool.ready} of ${pool.keys} keys still have some` +
      (pool.spent ? `, ${pool.spent} spent for today` : '') +
      `, resetting at ${back}. Keep answers brief if the user is working through something long.`
  ]
}

/**
 * The live facts block, built in exactly one place.
 *
 * Deliberately no clock time and no message count. Both changed on every turn
 * and bought nothing, while making this block differ each time.
 */
/**
 * How the person is talking to Wumpy this turn: through the earbuds, or at
 * the screen.
 *
 * A voice turn reads the answer aloud and skips everything that is not
 * prose, so an answer written for the screen - a table, a list of steps, a
 * link - arrives as a few disconnected words or as silence. The model cannot
 * tell from the text alone: a dictated question and a spoken one look the
 * same. So the app, which knows, says. Both ways round, because a chat that
 * was on the earbuds a minute ago should go back to normal answers once the
 * person is typing again.
 */
/*
 * A tone, asked for lightly: "add like kind of a tone to the AI... just don't
 * make it too heavy. And make it fast, quick, responsive... I also need a bit
 * of smartness, because that's the whole point of it." So one line of
 * character, the same on the screen and in the ear, and the rest is about
 * getting to the answer.
 */
const TONE =
  '- Tone: a sharp, easygoing friend - warm, quick, a light touch of humour when it fits, never chatty.'

function channelFacts(handsFree: boolean): string[] {
  if (!handsFree)
    return ['- The user is at the screen, reading your answers (not on their earbuds).', TONE]
  return [
    '- RIGHT NOW THE USER IS ON THEIR EARBUDS, not looking at the screen. They spoke this, and',
    '  your answer will be read aloud to them. Only plain prose is read: code, tables and links',
    '  are skipped. So answer like a person talking - one to three short sentences, plain words,',
    '  no markdown, no lists, no headings, no emoji.',
    TONE,
    '- Lead with the answer itself: "Five." - not "The answer to two plus three is five." Your first',
    '  sentence is spoken while you are still writing the rest, so make it the one that matters.',
    '  No filler, no "Great question", no repeating the question back.',
    '- Write everything the way it is said: "about twenty degrees", "forty percent", "half past',
    '  three" - no symbols, units or abbreviations. Round numbers unless the exact figure is the point.',
    '- Their words came through speech recognition and can be a little off ("a clean bottle" for',
    '  "a clear bottle"). Answer what they most likely meant. If it makes no sense at all, say you',
    "  didn't catch that, in a few words. Only ask back when you truly must: replying means",
    '  pinching again. For the same reason, no closing offers ("Want me to...?") unless it is',
    '  clearly the next step.',
    '- Commands still work. When the answer depends on this computer, propose ONE command as',
    '  usual. Its # line is what they hear as the question ("Can I <# line>?") and they answer',
    '  yes or no out loud - so write it as a short plain action: "# Check how full the disk is".',
    '- When output comes back, say what it means in a sentence. Never read output, paths or',
    '  numbers with many digits aloud unless they asked for exactly that.',
    '- If something needs their eyes or a click, say so in a sentence: they will look later.'
  ]
}

function factsFor(chatTitle: string | null, actions: string[] = [], handsFree = false): string {
  const now = new Date()
  return [
    'Facts about right now. If the user asks about any of these, just state the answer.',
    `- Today is ${now.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })}.`,
    `- This chat is titled ${chatTitle ? `"${chatTitle}"` : 'untitled so far'}.`,
    process.platform === 'win32'
      ? `- The user is on Windows. Commands run from ${settings.get('shellCwd') || homedir()}.`
      : `- The user is on Omarchy (Arch Linux, Hyprland). Commands run in bash from ${settings.get('shellCwd') || homedir()}.`,
    // Resolved by asking Windows at startup, not guessed. Documents,
    // Pictures and Desktop are redirected to OneDrive here, and the model
    // guessed $env:USERPROFILE\Documents - which returned an empty stdout
    // and an empty stderr, so the wrong folder was indistinguishable from
    // an empty one.
    ...folderFacts(),
    ...channelFacts(handsFree),
    // One file the user owns, carried from chat to chat. See context.ts.
    ...notes.forPrompt(),
    // Silent unless something is running out. See quotaFacts.
    ...quotaFacts(),
    // Written by the code that performed them, not recalled by the model.
    // Asked whether it had opened Spotify, the model denied it three times -
    // the app had the receipt and was not showing it.
    ...actions
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The system prompt, built in exactly one place.
 *
 * It was built twice - once to prime the cache at startup, once per turn - and
 * the two copies had already drifted: only one filtered out the empty string
 * left behind when web search is off. With search off they differed by a blank
 * line, which is enough for llama.cpp to find no common prefix and re-process
 * the whole preamble on every single turn. Nothing would look wrong; it would
 * just be slow for a reason nobody could see.
 */
/*
 * The sections and their order moved to @shared/assistant, so the panel can
 * measure the preamble instead of treating it as free. This is now only the
 * mapping from settings to that shape - which is the part that belongs here,
 * because settings do.
 */
/**
 * The vision model that can answer right now, or null.
 *
 * Null is the ordinary case for a model that can already see, and for one
 * that cannot when there is no key for the eye's provider - in which case
 * a look is names-only exactly as it was.
 *
 * Module scope rather than inside registerIpc, because the preamble has to
 * ask the same question: a model that is going to be handed a description
 * of the screen must be told that is what happens. Two copies of this
 * expression is exactly the drift that `systemPromptFor` exists to stop.
 */
function readyEye(): CloudModel | null {
  return eyeReady(activeModel(), keys.configured())
}

function promptShape(
  assistant: Assistant,
  scope: 'none' | 'read' | 'full',
  needs?: readonly Capability[]
): PromptShape {
  const engine = settings.get('searchEngine')
  return {
    scope,
    base: assistant.systemPrompt,
    search: settings.get('searchEnabled'),
    screen: settings.get('screenEnabled'),
    browser: settings.get('browserEnabled'),
    /*
     * Only when there is a pool to talk about, and only when the model being
     * answered with is actually counted that way.
     *
     * It used to ask whether any Google key existed, which was the same
     * question while Google was the only thing offered. It is not now: on
     * NVIDIA the budget is per minute with no daily allowance to run out, so
     * five lines about rotating daily keys and `/usage` would be advice
     * about a limit this turn cannot hit - paid for on every single turn.
     */
    quota: providerFor(activeModel()) === 'google' && keys.count('google') > 0,
    /* So it can say which, instead of guessing from the last card it saw.
       Validated here rather than trusted: the settings file is typed as a
       string and a hand-edited one may say anything. */
    engine: isSearchEngine(engine) ? engine : DEFAULT_ENGINE,
    needs,
    /* An environment variable as well, because the benchmarks set it and a
       bench should not have to write the user's settings file to run. */
    lean: settings.get('leanPrompt') || process.env.WUMPY_LEAN === '1',
    platform: process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : 'win32',
    /* Which of the two screen sections is true for this model. The bytes are
       dropped for the ones that cannot read them, so promising a photograph
       would describe a turn that cannot happen. */
    sees: seesMedia(activeModel()),
    /*
     * And whether a vision model is standing in for it.
     *
     * The same rule as `sees`, one turn later. A blind model with an eye
     * configured is handed a written description of the screen alongside
     * the control list, and NAMES_PROMPT tells it the opposite - that it
     * cannot know how anything looks and should say so. That is the first
     * bug inverted: the app used to promise a picture and send none, and
     * now it sends a description the prompt says will not arrive.
     */
    eye: readyEye() !== null
  }
}

/**
 * The preamble for this turn.
 *
 * `needs` is worked out from the messages as they will be SENT - after the
 * picture trimming, so a screenshot that is no longer going out is not a
 * reason to send 1,546 tokens of aiming rules. Without messages it falls back
 * to everything, which is what the benchmarks and the first-run path want.
 */
function systemPromptFor(
  assistant: Assistant,
  scope: 'none' | 'read' | 'full',
  sent?: ReturnType<typeof withContext>
): string {
  return assemblePrompt(promptShape(assistant, scope, sent ? needsFor(sent) : undefined))
}

/**
 * The assistant as currently configured.
 *
 * Built per turn rather than held as a constant because the two things that
 * shape it - which model, and whether shell is on - are settings the user can
 * change between questions.
 */
function currentAssistant(): Assistant {
  return assistantFor(activeModel(), settings.get('shellEnabled'), settings.get('thinking'))
}

/**
 * Warming is gone with the local path, and that is a real loss worth naming.
 *
 * Priming Ollama's KV cache with exactly the preamble the next turn would
 * send took the first question from 30.6-36.2s of prefill to 0.85-0.97s -
 * the largest single speed-up ever measured in this app. None of it applies
 * to a hosted model: there is no load to skip and no cache of ours to prime,
 * and the first-token cost is a round trip, which no amount of priming
 * shortens. Measured on Codestral that round trip is 0.51s, which is why
 * losing the warm-up does not cost anything the user can feel.
 */

/* ----------------------------------------------------------------- hotkeys */

function applyHotkeys(): void {
  const intercepted = hotkeyState.intercepted
  hotkeyState = registerHotkeys(settings.get('hotkeys'), () => panel.toggle())
  // The low-level hook is owned separately; preserve what it already claimed.
  hotkeyState.intercepted = intercepted

  if (hotkeyState.active) {
    console.log(`[wumpy] accelerator active: ${hotkeyState.active}`)
  } else if (hotkeyState.failed.length > 0) {
    console.warn('[wumpy] no accelerator could be registered:', hotkeyState.failed.join(', '))
  }
  // An empty candidate list is the default and not worth a warning: Win+C comes
  // from the low-level hook, so extra accelerators are opt-in.
  tray?.refresh()
  panel.send(IPC.hotkeyState, hotkeyState)
}

/**
 * Claims Win+Shift+D through the helper process - the same shortcut Omarchy
 * gets through a Hyprland binding, so it is one combination on every machine.
 * The helper sits below the shell, so the keystroke never reaches anything
 * else (the dedicated Copilot key is still caught too).
 */
async function startLowLevelHook(): Promise<void> {
  /* Linux has no keyboard hook to install: Hyprland owns the keys, and a
     binding there runs `wumpy --toggle` (see the README). */
  if (process.platform === 'linux') {
    hotkeyState.intercepted = 'Super+Shift+D'
    return
  }
  lowLevelHook = new LowLevelHook('D', () => panel.toggle(), true)
  const ok = await lowLevelHook.start()
  hotkeyState.intercepted = ok ? 'Super+Shift+D' : null
  if (!ok) {
    lowLevelHook = null
    console.warn('[wumpy] Win+Shift+D interception unavailable; use the tray icon')
  } else {
    /**
     * The helper takes the foreground, not Wumpy.
     *
     * Windows grants that right to whoever received the keystroke, and that
     * is the helper - Wumpy only hears about the press afterwards, down a
     * pipe, by which time the right is gone. So the panel shows itself and
     * then asks the helper to hand it the keyboard.
     */
    const hook = lowLevelHook
    panel.setActivator((hwnd) => hook.activate(hwnd))
  }
  tray?.refresh()
  panel.send(IPC.hotkeyState, hotkeyState)
}

/* --------------------------------------------------------------------- IPC */

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settings.all())

  // Whoever changed them - the panel, the tray menu - every window hears about
  // it, so what the status bar shows is what this process will actually do.
  settings.onChange((next) => panel.send(IPC.settingsChanged, next))

  /**
   * And the timeline hears about it too, from the same place.
   *
   * Written off a DIFF rather than off the commands, because the commands
   * are not the only writer: the tray menu sets the approval mode with no
   * window open, the panel patches the dock when the hotkey moves it, and
   * the Google migration changed the model on one boot and told nobody. A
   * journal built from `/model` and friends would have been silent for
   * exactly the changes nobody saw happen.
   *
   * The latencies the ranker writes every few minutes are not in the
   * watched list, so a sweep does not produce nine lines of noise here -
   * it produces one 'rank' line of its own. See @shared/journal.
   */
  let known = settings.all()
  settings.onChange((next) => {
    for (const change of diffSettings(known, next)) journal.add(change.kind, change.what)
    known = next
  })

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WumpySettings>) => {
    const next = settings.patch(patch)
    if (patch.hotkeys) applyHotkeys()
    if (patch.tallWidth || patch.compactWidth || patch.compactHeight) panel.applyGeometry()
    if (patch.launchAtLogin !== undefined) syncLaunchAtLogin(patch.launchAtLogin)
    if (patch.model) void refreshModels()
    /* Turning dictation on warms the transcriber there and then, rather
       than leaving the first press of the key to pay for a Python
       process and a model load. Same warm-up as at startup; see where
       Speech is constructed for why it is worth doing early. */
    if (patch.voiceEnabled === true) {
      void speech.start().then(() => panel.send(IPC.voiceStatusChanged, voiceStatus()))
    }
    tray?.refresh()
    return next
  })

  ipcMain.handle(IPC.assistantStatus, () => assistantStatus())

  ipcMain.handle(IPC.chatSend, async (_e, req: ChatRequest) => {
    const assistant = currentAssistant()
    const model = resolveModel()

    if (!model) {
      // Not a missing install any more - there is nothing to install. It is a
      // missing key, so say which one and where to get it.
      const wanted = activeModel()
      const provider = providerFor(wanted)
      panel.send(IPC.chatError, {
        requestId: req.requestId,
        message: provider
          ? `${wanted} needs a ${PROVIDERS[provider].label} key. ` +
            `Add one with \`/key ${provider} <key>\`, or get one at ${PROVIDERS[provider].keyUrl}`
          : `${wanted} is not a model Wumpy knows how to reach. Pick one with /model.`
      })
      return
    }

    const scope = assistant.tools
    // The model is told what it can do in this tier, both ways round: with the
    // shell rules when it can act, and with an explicit "you cannot, say so"
    // when it cannot. Without the second half it invents having checked.
    // The system prompt must stay byte-identical between turns.
    //
    // llama.cpp reuses the KV cache for the longest common prefix of a request.
    // Live facts (the clock, the chat title) change every turn, so putting them
    // here invalidated the cache for the whole prompt *and* the conversation
    // behind it. Measured on llama3.2:3b with a 262-token prompt: 6-8s of
    // prefill per turn with volatile text first, 1.2-1.6s with it last, and
    // 165ms when the prefix is untouched. The facts now go in just ahead of the
    // latest question, so only they and that question are reprocessed.
    /* Built once, from the messages that are actually going out, and reused
       for every attempt including the fallback - so a retry cannot quietly
       send a different preamble from the one the meter counted. */
    const sending = withContext(req)
    await lendEyes(sending)
    const systemPrompt = systemPromptFor(assistant, scope, sending)

    // Stand aside for the duration of the turn: tokens matter more than UI.
    priority.yieldToModel()
    /* And the background ranking stops dead, mid-request if it is in one.
       Not after this model, not at the next tick: the user is waiting. */
    turnStartedAt = Date.now()
    ranker.cancel()

    /**
     * Runs one turn on one model, and says whether the local model should be
     * asked the same question instead.
     *
     * Resolves to the fallback model when the hosted one could not answer for
     * a reason the local one does not share - a quota, a throttle, a dropped
     * connection - and to null in every other case, including success.
     */
    /** Why the first attempt gave up, so the announcement can say so truthfully. */
    let fallbackWhy = 'could not answer'
    /**
     * The model turned out not to read pictures, which is not a failed turn.
     *
     * Every model is born sighted here (see seesMedia), so the first picture
     * sent to one that cannot read them is refused - as a 400, or, on NVIDIA,
     * as "Internal server error" inside a 200. That used to be the end of it:
     * the bytes were dropped and the model answered "I cannot see the image
     * you attached", which is true, useless, and not what the app can do.
     *
     * It can borrow eyes. `lendEyes` has been here all along for models the
     * catalogue already knew were blind; this is the turn that finds out, and
     * it now gets the same treatment instead of being spent on an apology.
     */
    let blind = false

    async function attempt(on: string, announce: string | null, patient = true): Promise<string | null> {
      let streamed = false
      let fallbackTo: string | null = null

      /* A voice turn's model gets VOICE_FIRST_TOKEN_MS to start, when there
         is a quicker one to hand it to (see @shared/voicequick). */
      let gaveUp = false
      const quicker =
        !patient && req.context.handsFree === true
          ? quickerModel(on, settings.get('latencies') ?? {}, (id) => !spentToday.has(id) && cloud.ready(id).ok)
          : null
      const watchdog = quicker
        ? setTimeout(() => {
            if (streamed) return
            gaveUp = true
            console.log(`[wumpy] ${on} said nothing in ${VOICE_FIRST_TOKEN_MS}ms of a voice turn; asking ${quicker}`)
            cloud.abort(req.requestId)
          }, VOICE_FIRST_TOKEN_MS)
        : null

      if (announce) {
        panel.send(IPC.chatDelta, { requestId: req.requestId, content: announce })
      }

      await cloud.chat(
        req.requestId,
        on,
        sending,
        {
          thinking: assistant.thinking,
          options: assistant.options,
          maxTurnMs: settings.get('maxTurnMs'),
          systemPrompt
        },
        {
          onDelta: (delta) => {
            if (gaveUp) return
            if (delta.content || delta.thinking) streamed = true
            panel.send(IPC.chatDelta, { requestId: req.requestId, ...delta })
          },
          onDone: (stats) => {
            /* Aborted by the watchdog: not the end of the turn, which goes
               on with the quicker model. */
            if (gaveUp) return
            // Counted here rather than inside either client, so both are
            // counted the same way and neither knows a usage store exists.
            usage.add({
              model: on,
              via: providerFor(on) ?? 'unknown',
              promptTokens: stats.promptTokens,
              completionTokens: stats.completionTokens,
              generatingMs:
                stats.tokensPerSecond && stats.completionTokens
                  ? (stats.completionTokens / stats.tokensPerSecond) * 1000
                  : 0
            })
            panel.send(IPC.chatDone, { requestId: req.requestId, ...stats })
          },
          onError: (message, failure) => {
            if (gaveUp) return
            /* Not an error the user has anything to do about: the picture
               was refused, the model is now on record as text-only, and the
               turn is about to be asked again with a description in place of
               the bytes. Nothing has been streamed - the sender only reports
               this before the first token. */
            if (failure?.kind === 'blind') {
              blind = true
              return
            }
            usage.add({
              model: on,
              via: providerFor(on) ?? 'unknown',
              error: true,
              limited: failure?.kind === 'limit',
              // "Out for the day" rather than "slow down": the request count
              // at this moment is the only cap figure anyone here can trust,
              // since the published ones contradict each other.
              exhausted:
                failure?.kind === 'limit' &&
                (failure.spent === true || /quota|used up|free quota/i.test(message)),
              // What the KEY had spent, which is the per-project cap. The
              // pool's own total is twenty times that with twenty keys.
              exhaustedAfter: failure?.afterRequests
            })

            /* The flag when the sender set one, the words when it did not:
               classifyLimit still reports a single key's exhaustion in prose. */
            if (
              failure?.kind === 'limit' &&
              (failure.spent === true || /used up its free requests/.test(message))
            ) {
              spentToday.add(on)
            }
            // A model the provider will not generate with is worse than
            // spent: it will never work today or any other day, so it must
            // not be offered as somewhere to step sideways to.
            if (failure?.kind === 'unusable') spentToday.add(on)

            /**
             * Sideways before down.
             *
             * The daily cap is per model, so when one Gemini is out another
             * usually is not - measured, on the same key in the same minute.
             * Dropping to a 3.8B local model while a perfectly good hosted
             * one sits unused throws away the reason for being here at all.
             */
            const sibling = failure?.kind === 'limit' ? siblingModel(on, spentToday) : null
            const elsewhere = sibling && cloud.ready(sibling).ok ? sibling : null
            /**
             * Only when nothing has been said yet.
             *
             * Half an answer from one model followed by a whole one from
             * another is not a fallback, it is two answers stitched together,
             * and the user would have no way to tell where the seam is. A
             * rate limit always fails before the first token, so this costs
             * nothing in the case it exists for.
             */
            if (settings.get('apiFallback') && failure?.elsewhere && elsewhere && !streamed) {
              fallbackTo = elsewhere
              fallbackWhy =
                failure.kind === 'network'
                  ? 'could not be reached'
                  : failure.kind === 'unusable'
                    ? 'is not available on this key'
                    : spentToday.has(on)
                      ? 'is out of free requests for today'
                      : 'is rate limited'
              return
            }

            panel.send(IPC.chatError, { requestId: req.requestId, message })
          }
        }
      )
      if (watchdog) clearTimeout(watchdog)
      if (gaveUp && quicker) {
        fallbackWhy = `had not started after ${VOICE_FIRST_TOKEN_MS / 1000}s`
        return quicker
      }
      return fallbackTo
    }

    let fallback = await attempt(model, null, false)

    /**
     * The picture was refused, so it is looked at by something that can.
     *
     * One extra request per model per session, which is what the optimistic
     * default costs and was always going to cost. `seesMedia` is false from
     * here on, so this cannot repeat and the bytes do not go out again -
     * `lendEyes` turns them into a description, and `wireMessage` says the
     * picture was not sent if there was no eye to borrow.
     *
     * The same systemPrompt as the first attempt, deliberately: it was built
     * once from these messages, the meter counted it, and a second preamble
     * mid-turn is the thing the comment above it exists to prevent.
     */
    if (blind) {
      blind = false
      const eye = await lendEyes(sending)
      fallback = await attempt(
        model,
        `_${model} cannot read pictures` +
          (eye ? ` — ${eye.label} looked at it instead.` : ', and nothing here can.') +
          `_${String.fromCharCode(10, 10)}`
      )
    }

    if (fallback) {
      /**
       * Said out loud, every time, before the second answer starts.
       *
       * Knowing which model answered is the point. This used to guard a
       * downgrade to a 3.8B local model, which would have been the difference
       * between a good answer and a poor one; it now guards a step sideways
       * to a sibling, which is smaller but still something the reader cannot
       * work out for themselves.
       */
      await attempt(
        fallback,
        `_${model} ${fallbackWhy} — answering on ${fallback} instead._` +
          String.fromCharCode(10, 10)
      )
    }

    priority.restore()
    turnStartedAt = null
    lastTurnEndedAt = Date.now()
  })

  /**
   * How many separate free tiers this machine actually has.
   *
   * One per key, because each is its own Google Cloud project. Counted at
   * read time rather than remembered, so adding ten more keys widens the
   * meter immediately instead of after a restart.
   */
  /**
   * How many separate allowances there are to spend. One per key: a Google
   * key is its own project, and every other key is added from its own
   * account. See `budgetsFor`.
   */
  const freeTiers = (): number => {
    const provider = providerFor(activeModel())
    if (!provider) return 1
    return budgetsFor(provider, keys.count(provider))
  }

  /**
   * The day's report, with the pool behind it.
   *
   * The two halves used to be kept apart: the counters knew "forty turns
   * today" and the rotation knew "three keys are resting", and neither could
   * answer "how much is left". This joins them for whichever model is
   * answering, using the cap that model has actually been observed to have.
   */
  const report = (): UsageReport => {
    const model = activeModel()
    /* No 'google' fallback: a model that routes nowhere has no provider, and
       reading Google's row for it was how an unroutable name picked up a cap
       measured on Gemini. */
    const cap = perKeyCapFor(usage.today(), model, providerFor(model) ?? '')
    return {
      lines: usage.lines(freeTiers()),
      model,
      date: usage.today().date,
      pool: cloud.poolFor(model, cap)
    }
  }

  ipcMain.handle(IPC.usageGet, () => report())

  /**
   * What the background ranking is doing, and what is stopping it.
   *
   * The traffic goes over with it rather than a verdict: the rules are
   * pure and the panel runs the same ones, so `/rank` can say "paused -
   * you are using the account" without main having to format a sentence.
   */
  ipcMain.handle(IPC.rankState, (): RankView => {
    const view = ranker.view()
    const provider = providerFor(activeModel())
    const gap = provider ? PROVIDERS[provider].minGapMs : 0
    return {
      on: view.on,
      keys: view.keys,
      sinceProbeMs: view.sinceProbeMs,
      sinceSweepMs: view.sinceSweepMs,
      left: view.left,
      lastSweepMs: view.lastSweepMs,
      traffic: {
        busy: turnStartedAt !== null,
        sinceTurnMs: lastTurnEndedAt ? Date.now() - lastTurnEndedAt : Infinity,
        lastMinute: provider ? requestsInLastMinute(provider) : 0,
        perMinute: gap > 0 ? Math.round(60_000 / gap) : 0,
        sinceLimitedMs: provider ? sinceLimited(provider) : Infinity
      }
    }
  })

  ipcMain.handle(IPC.rankSet, (_e, req: { on?: boolean; now?: boolean }) => {
    if (typeof req?.on === 'boolean') settings.patch({ autoRank: req.on })
    /* `now` still obeys every rule about the user's traffic - it moves the
       hour, not the right of way. */
    if (req?.now) ranker.sweepNow()
    return true
  })

  /**
   * The timeline, oldest first. `/log` does the ordering and the wording.
   *
   * A plain read: no argument, nothing to filter on this side, and nothing
   * in the reply that is not already in the panel - see @shared/journal for
   * what is deliberately never recorded.
   */
  ipcMain.handle(IPC.journalGet, (): Entry[] => [...journal.all()])

  /**
   * Forget it, and say how much there was to forget.
   *
   * Nothing is written in its place. A 'cleared' line would need a word in
   * the table that means neither of the two things the columns say, and the
   * person who just typed `/log clear` is not the person who needs telling
   * that they did.
   */
  ipcMain.handle(IPC.journalClear, (): number => {
    const had = journal.all().length
    journal.clear()
    return had
  })

  /**
   * What Wumpy costs the machine, measured rather than estimated.
   *
   * Two readings, because Electron's `percentCPUUsage` is the share of a
   * core since the LAST time this was asked - so a single call reports the
   * average since the process started, which for an app that launched at
   * login is a number from hours ago. The first reading is thrown away and
   * exists only to start the clock; the second is the half second that just
   * happened.
   *
   * Sampled only when the user asks. Half a second of waiting is nothing on
   * a command somebody typed, and a background sampler would be the exact
   * thing this is meant to measure.
   */
  /* Long enough that a timer firing in it does not read as a busy app, short
     enough to sit inside a command the user typed. */
  const SAMPLE_MS = 500

  ipcMain.handle(IPC.usageFootprint, async (): Promise<Footprint> => {
    app.getAppMetrics()
    const began = Date.now()
    await new Promise((r) => setTimeout(r, SAMPLE_MS))
    const metrics = app.getAppMetrics()
    return {
      processes: metrics.map((m) => ({
        pid: m.pid,
        type: m.type,
        name: m.name,
        memoryKb: m.memory?.workingSetSize ?? 0,
        cpuPercent: Math.max(0, m.cpu?.percentCPUUsage ?? 0)
      })),
      cores: cpus().length,
      sampledMs: Date.now() - began,
      /* The main process, which is the one that has been up since login.
         A renderer is younger whenever the panel has been reloaded. */
      upMs: Math.round(process.uptime() * 1000)
    }
  })

  ipcMain.handle(IPC.usageReset, () => {
    usage.reset()
    return report()
  })

  /**
   * Which models answer, asked rather than assumed. See @shared/probe.
   *
   * THE REQUESTS ARE COUNTED LIKE ANY OTHER, which is the only honest choice
   * available: they are real requests against a real allowance, and a meter
   * that ignored them would read low by one per model every time this is
   * run. They are recorded against the model they tested, because that is
   * where the provider counted them.
   *
   * Errors are recorded too, so a probe that found a dead model leaves the
   * same trace in `/usage` as a turn that hit it would have.
   */
  ipcMain.handle(IPC.modelsProbe, async (_e, req?: { runs?: number }) => {
    /*
     * The same instructions a question would carry, so the times are the
     * times a question pays. Without them the probe measured the queue and
     * nothing else, and called a model 1.6s that takes fifty seconds in
     * use. `needs` is left undefined, which means everything: the heaviest
     * preamble the app ever sends, so the figure is a ceiling rather than
     * a best case.
     */
    const forProbe = currentAssistant()
    const preamble = systemPromptFor(forProbe, forProbe.tools)
    const results = await cloud.probeModels(req?.runs ?? DEFAULT_RUNS, undefined, preamble)
    for (const r of results) {
      if (!spent(r.state)) continue
      usage.add({
        model: r.model,
        via: r.provider || 'unknown',
        generatingMs: r.ms,
        error: !usable(r.state),
        limited: r.state === 'limited',
        /*
         * NOT `exhausted`, although a 429 is what sets that elsewhere.
         *
         * `exhaustedAt` means "one key's daily cap is the count at this
         * moment", and a probe cannot know it has found one: a 429 is
         * equally a per-minute throttle, which is what thirteen requests in
         * a row are most likely to provoke. Writing one in would pin a cap
         * of two or three requests a day for a model that has hundreds -
         * the same class of mistake as the pool total once recorded as a
         * per-key figure, and it would show as a meter reading 100% while
         * everything still worked. The real turn path classifies the
         * refusal properly and is welcome to record it.
         */
      })
    }
    usage.flush()
    return results
  })

  /**
   * Summarises older turns so a long conversation keeps fitting in the model's
   * context window. Returns the summary text; the renderer decides what to
   * replace with it.
   */
  ipcMain.handle(
    IPC.chatCompact,
    async (_e, req: { messages: Array<{ role: string; content: string }> }) => {
      const model = backgroundModel()
      if (!model || req.messages.length === 0) return null

      const transcript = req.messages
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n')

      return cloud.complete(
        model,
        [
          {
            role: 'system',
            content:
              'You compress conversations so they can be carried forward as context. ' +
              'Write a dense summary in the third person. Preserve decisions, facts, ' +
              'names, file paths, code identifiers and anything the user asked for. ' +
              'Drop pleasantries and repetition. No preamble, no headings.'
          },
          { role: 'user', content: `Summarise this conversation:\n\n${transcript}` }
        ],
        { numPredict: 500 }
      )
    }
  )

  /**
   * Names a conversation from the questions in it. Caps output hard, because
   * this happens in the background right after an answer lands.
   *
   * Called more than once per chat - see shouldRetitle - so it is written to
   * work as well on the twentieth question as on the first.
   */
  ipcMain.handle(
    IPC.chatTitle,
    async (_e, req: { messages: Array<{ role: string; content: string }> }) => {
      const model = backgroundModel()
      const questions = req.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content.trim())
        .filter(Boolean)
      if (!model || questions.length === 0) return null

      // Title from the questions alone, never the answers.
      //
      // Feeding the assistant's reply in made the model title the reply: asking
      // "what is speculative fiction" came back as "Exploring the Realm of
      // Speculative". Measured on llama3.2:3b, the question alone is both
      // accurate and about twice as fast. That holds however many there are,
      // so a retitle sees every question and none of the replies.
      const source = titleSource(questions)

      const raw = await cloud.complete(
        model,
        [
          {
            role: 'system',
            content: titleBrief(questions.length)
          },
          { role: 'user', content: source }
        ],
        { numPredict: 20 }
      )

      // cleanTitle repairs a split word against the text it came from, so it
      // gets every question - a word from turn six is just as real as one
      // from turn one.
      return raw ? cleanTitle(raw, source) : null
    }
  )

  /* -------------------------------------------------------------- file writes */

  /**
   * Creates a file the user approved.
   *
   * Deliberately not a shell command. A multi-line file inside a PowerShell
   * command needs a here-string and exact escaping, and a small model does not
   * produce one - it reached for `New-Item -Content { ... }`, whose braces
   * PowerShell reads as a script block, so the Python inside was parsed as
   * PowerShell and came back as eight parser errors. Here the content never
   * meets a parser.
   */
  ipcMain.handle(IPC.writeFile, (_e, req: { path: string; content: string }) => {
    if (!settings.get('shellEnabled')) {
      return {
        written: false,
        path: '',
        bytes: 0,
        overwrote: false,
        error: 'Commands are turned off.'
      }
    }
    const result = writeProposedFile(req.path, req.content, settings.get('shellCwd') || homedir())
    /* Where it landed, not where it was asked for: the two differ whenever a
       relative path was resolved, and the resolved one is the file that now
       exists. Only on success - a refused write left nothing behind. */
    if (result.written) journal.add('write', result.path)
    return result
  })

  ipcMain.handle(IPC.writeCheck, (_e, path: string) =>
    inspectWriteTarget(path, settings.get('shellCwd') || homedir())
  )

  /* ------------------------------------------------------------------ browser */

  /**
   * Opens a page in the real browser.
   *
   * Reached three ways, and they are not equivalent: the user typing `/open`,
   * the user clicking a card the model proposed, and a card opening itself under
   * accept-all. All three come through here, and here re-checks the link - the
   * renderer's own check is for telling the user what will happen, not for
   * deciding, because the renderer is downstream of model output.
   */
  ipcMain.handle(IPC.linkOpen, async (_e, raw: string) => {
    if (!settings.get('browserEnabled')) {
      return { opened: false, url: '', host: '', error: 'Opening pages is turned off in settings.' }
    }
    const result = await openLink(raw)
    /* The host, which is what the card showed and what somebody would
       recognise. Never the full URL: a link can carry a session token in
       its query string, and this file is not the place for one. */
    if (result.opened) journal.add('open', result.host)
    return result
  })

  ipcMain.handle(IPC.linkSearch, async (_e, query: string) => {
    if (!settings.get('browserEnabled')) {
      return { opened: false, url: '', host: '', error: 'Opening pages is turned off in settings.' }
    }
    const engine = settings.get('searchEngine')
    const result = await openSearch(query, isSearchEngine(engine) ? engine : DEFAULT_ENGINE)
    if (result.opened) journal.add('search', `${query} (in ${result.host})`)
    return result
  })

  /** What the panel needs to describe a link before anything is opened. */
  ipcMain.handle(IPC.linkCheck, (_e, raw: string) => checkLink(raw))

  /* ------------------------------------------------------------------- voice */

  ipcMain.handle(IPC.voiceStatus, () => voiceStatus())

  // Starting the transcriber loads a model, so it is done when the panel asks
  // rather than at launch: someone who never dictates never pays for it. With
  // hosted speech there is nothing to load at all.
  ipcMain.handle(IPC.voiceStart, async () => {
    if (!cloudSpeech()) await speech.start()
    const status = voiceStatus()
    panel.send(IPC.voiceStatusChanged, status)
    return status
  })

  /**
   * Self-reflection's mentor: one review of a finished task.
   *
   * The same model as the worker unless /reflect model chose another, and on
   * the other key where there are two (complete's otherKey), so the review
   * spends the allowance the work did not. Thinking is off in complete(), and
   * the budget is enough for a numbered list of changes, not an essay. Null
   * when no review could be had - the renderer then says so and stops rather
   * than calling unreviewed work accepted.
   */
  ipcMain.handle(
    IPC.reflectReview,
    async (_e, req: { transcript: string }): Promise<ReflectReview | null> => {
      const chosen = settings.get('reflectModel')
      const model = chosen && cloud.ready(chosen).ok ? chosen : resolveModel()
      if (!model || !req.transcript.trim()) return null
      const raw = await cloud.complete(
        model,
        [
          { role: 'system', content: MENTOR_PROMPT },
          { role: 'user', content: `The task and the worker's work so far:\n\n${req.transcript}` }
        ],
        { numPredict: 900, otherKey: true }
      )
      const review = raw ? parseReview(raw) : null
      return review ? { ...review, model } : null
    }
  )

  /**
   * An answer, spoken. Magpie when hosted speech is on; null otherwise, and
   * the panel then uses the system's own voice. Never throws: a voice that
   * fails is a turn that stays silent, not a turn that breaks.
   */
  ipcMain.handle(IPC.voiceSpeak, async (_e, req: { text: string }) => {
    const text = String(req?.text ?? '').trim().slice(0, 1800)
    if (!text || !cloudSpeech()) return null
    const borrowed = await cloud.speechKey('magpie')
    if (!borrowed) return null
    try {
      const { wav } = await synthesize(text, borrowed, settings.get('speakVoice') || DEFAULT_VOICE)
      return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength)
    } catch (err) {
      console.warn('[wumpy] Magpie could not speak:', err)
      return null
    }
  })

  /**
   * The same, streamed: each piece of sound goes to the panel as Magpie
   * makes it (IPC.voiceAudio), and this resolves once the last has gone,
   * with how many there were - so the panel knows when it has them all.
   * Null when there is no hosted voice or it failed before saying anything;
   * the panel then uses the system's voice for that sentence.
   */
  ipcMain.handle(IPC.voiceSpeakStream, async (e, req: { id: string; text: string }) => {
    const text = String(req?.text ?? '').trim().slice(0, 1800)
    const id = String(req?.id ?? '')
    if (!text || !id || !cloudSpeech()) return null
    const borrowed = await cloud.speechKey('magpie')
    if (!borrowed) return null
    let sent = 0
    try {
      const result = await synthesizeStream(text, borrowed, settings.get('speakVoice') || DEFAULT_VOICE, (pcm) => {
        sent++
        e.sender.send(IPC.voiceAudio, { id, pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) })
      })
      return { pieces: result.pieces, rate: TTS_RATE, firstMs: result.firstMs, ms: result.ms, streamed: result.streamed }
    } catch (err) {
      console.warn('[wumpy] Magpie could not speak:', err)
      return sent ? { pieces: sent, rate: TTS_RATE, firstMs: -1, ms: -1, streamed: true } : null
    }
  })

  /*
   * Music off while Wumpy listens and talks. The setting is read on the
   * hold only: a release always goes through, so turning it off mid-turn
   * cannot leave somebody's song paused for good.
   */
  ipcMain.handle(IPC.musicHold, async () => {
    if (settings.get('pauseMusic') !== false) await holdMusic()
  })
  ipcMain.handle(IPC.musicRelease, async () => {
    await releaseMusic()
  })

  ipcMain.on(IPC.appRestart, (_e, req: { chatId?: string | null; why?: string }) => {
    void restartWumpy(String(req?.why ?? '/restart'), req?.chatId ?? null)
  })
  /* Once: a reload of the page later must not drag the user back to it. */
  ipcMain.handle(IPC.appLaunchChat, () => {
    const id = launchChat
    launchChat = null
    if (id) console.log(`[wumpy] back on chat ${id} after a restart`)
    return id
  })

  /**
   * Turns a recorded clip into text for the composer.
   *
   * Three stages, and only the first is unavoidable. Whisper transcribes;
   * `tidyTranscript` applies the table of things an acoustic model cannot know
   * about this app; and then, optionally, the local model punctuates it. The
   * result goes into the box, never straight to the model - dictation is typing,
   * and a mis-heard sentence has to be as easy to correct as a mistyped one.
   */
  /**
   * Everything after Whisper: vocabulary, noise, and the optional polish.
   *
   * Shared by the two ways a transcript arrives - a clip, or text already
   * assembled from pieces transcribed while the user was still speaking.
   */
  async function finishTranscript(
    heard: string,
    commands: string[],
    confidence: number,
    ms: number
  ): Promise<{
    text: string
    heard: string
    polished: boolean
    polishRefused: boolean
    confidence: number
    ms: number
  }> {
    const bare = { text: '', heard, polished: false, polishRefused: false, confidence, ms }

    // The command list comes from the panel, which owns it, so a command added
    // later is dictatable without this file having to hear about it.
    const tidied = tidyTranscript(heard, { commands })
    if (!tidied) return bare
    if (!settings.get('voicePolish')) return { ...bare, text: tidied }

    // The quickest installed model, for the same reason titles use it: the
    // user is waiting to read this and press Enter.
    const model = backgroundModel()
    if (!model) return { ...bare, text: tidied }

    const polished = await cloud.complete(
      model,
      [
        { role: 'system', content: POLISH_PROMPT },
        { role: 'user', content: tidied }
      ],
      { numPredict: 120 }
    )

    const accepted = polished !== null && polishAcceptable(tidied, polished)
    if (polished !== null && !accepted) {
      console.warn(`[wumpy] polish refused: ${JSON.stringify(polished.slice(0, 120))}`)
    }
    return {
      ...bare,
      text: accepted ? polished!.trim() : tidied,
      polished: accepted,
      polishRefused: polished !== null && !accepted
    }
  }

  ipcMain.handle(
    IPC.voiceTranscribe,
    async (_e, req: { audio: ArrayBuffer; extension?: string; commands?: string[] }) => {
      const clip = await hear(new Uint8Array(req.audio), req.extension ?? 'webm')
      return finishTranscript(clip.text.trim(), req.commands ?? [], clip.confidence, clip.ms)
    }
  )

  /**
   * The same cleanup, for text that has already been through Whisper.
   *
   * Dictation is transcribed in pieces as it is spoken, so by the time the
   * user stops there is a string rather than a clip. It still needs the
   * vocabulary fixes, the noise filter and the polish pass - more than one
   * clip did, because the seams between pieces are where a capital or a full
   * stop goes missing. This is that half of the pipeline on its own.
   */
  ipcMain.handle(IPC.voiceTidy, async (_e, req: { text: string; commands?: string[] }) =>
    finishTranscript((req.text ?? '').trim(), req.commands ?? [], 1, 0)
  )

  /**
   * What a listening session is hearing, written down.
   *
   * Flattened and capped here rather than trusted. This is the one channel
   * that puts renderer text straight into the log file, and a newline in it
   * would forge a timestamped line; 300 characters is more than any line the
   * session actually writes and far less than a transcript, so a mistake
   * upstream cannot quietly turn the log into a copy of the meeting.
   */
  ipcMain.on(IPC.listenLog, (_e, line: unknown) =>
    log(`[listen] ${String(line).replace(/\s+/g, ' ').slice(0, 300)}`)
  )

  /**
   * Runs a web search the user approved. Like commands, the query leaves this
   * machine only after a click: a model can put anything in it, including
   * whatever it has just read.
   */
  /**
   * A photograph of the screen, and only on a click.
   *
   * There is no autonomous path to this handler. The model can only ask, by
   * proposing a block that renders as a card; the capture happens when the
   * user presses it, and the image then appears in the transcript so they
   * can see exactly what was sent.
   */
  /**
   * A photograph, and what everything in it is CALLED.
   *
   * One function because both callers need both halves. The second one - the
   * picture a plan returns - was taking the photograph alone, which meant
   * every screenshot after the first arrived with no names attached. So the
   * model was handed a list of controls once, at the start, and then asked to
   * carry on from pictures; the log of a failed "email Stanley" is ten rounds
   * of nudged coordinates, which is what a nameless picture leaves it.
   *
   * A picture alone makes the model estimate pixels, and an estimate off a
   * scaled image is wrong identically every time - which is exactly what
   * "keeps clicking the same place every time" looked like.
   */
  /**
   * What the picture shows, asked of a model that can see it.
   *
   * Second-hand by construction, and said so everywhere it is used. The
   * instruction is written against the two ways this goes wrong: a
   * description that is a guided tour of the desktop when one sentence was
   * needed, and a description that helpfully invents the thing it was
   * expected to find. Nothing here asks for advice - the model being lent
   * these eyes is the one doing the thinking.
   */
  async function readPicture(
    eye: CloudModel,
    picture: { dataUrl: string; bytes?: number },
    about: 'screen' | 'file',
    ask?: string
  ): Promise<string | null> {
    if (!picture.dataUrl) return null
    const started = Date.now()
    try {
      const text = await cloud.complete(
        eye.id,
        [
          {
            role: 'user',
            content: [
              'You are the eyes for another model, which cannot see pictures.',
              ...(about === 'screen'
                ? [
                    'It is driving this Windows desktop and already has the list of',
                    'control names, so describe what the names cannot say:'
                  ]
                : ['A person attached this image to a question for it. Describe it:']),
              '- what this is, and what state it is in',
              '- any text that matters: errors, dialogs, headings, field contents',
              '- anything visibly wrong, empty, loading or greyed out',
              'At most 120 words. Report ONLY what is visible. If something is',
              'unreadable, say so. Do not guess at what is cut off, do not give',
              'advice, and do not say what should be done next.',
              ...(ask ? ['', `Answer this in particular: ${ask.slice(0, 400)}`] : [])
            ].join(String.fromCharCode(10)),
            /* The eye is sent the bytes and nothing else: width, height and
               the rest belong to the transcript, not to this question. */
            images: [
              {
                kind: 'image' as const,
                dataUrl: picture.dataUrl,
                width: 0,
                height: 0,
                bytes: picture.bytes ?? 0
              }
            ]
          }
        ],
        { numPredict: 400, pictures: true }
      )
      if (text) console.log(`[wumpy] ${eye.label} read a ${about} in ${Date.now() - started}ms`)
      return text?.trim() || null
    } catch {
      /* An eye that failed is a turn without one, which is every turn
         yesterday. Never a reason to fail the answer. */
      return null
    }
  }

  /** The screen, photographed here and read there. */
  async function lookFor(eye: CloudModel): Promise<string | null> {
    try {
      const shot = await captureScreen(panel.liveWindow())
      return await readPicture(eye, shot, 'screen')
    } catch {
      return null
    }
  }

  /**
   * A picture the user attached, for a model that cannot open it.
   *
   * Until now the composer refused the paste outright, which is honest and
   * useless: "an annoying thing is that the model does not support images".
   * The bytes now go to the eye and its answer goes in as text, marked as
   * second-hand so the answering model does not claim to have seen it.
   *
   * The newest user turn only, and two pictures at most. Every older image
   * has already been through here on the turn it arrived, and re-reading
   * the whole transcript each turn is the quadratic cost trimPictures
   * exists to stop.
   */
  async function lendEyes(
    messages: Array<Pick<ChatMessage, 'role' | 'content' | 'images'>>
  ): Promise<CloudModel | null> {
    if (seesMedia(activeModel())) return null
    const eye = readyEye()
    if (!eye) return null
    const last = [...messages].reverse().find((m) => m.role === 'user' && m.images?.length)
    if (!last) return null
    const pictures = (last.images ?? [])
      .filter((a) => (a.kind ?? 'image') === 'image' && a.dataUrl)
      .slice(0, 2)
    if (!pictures.length) return null

    const seen: string[] = []
    for (const picture of pictures) {
      const text = await readPicture(eye, picture, 'file', last.content)
      if (text) seen.push(text)
    }
    if (!seen.length) return null
    last.content = [
      last.content,
      '',
      `[${pictures.length === 1 ? 'An image was' : `${pictures.length} images were`} attached` +
        ` to this message. You cannot read pictures, so ${eye.label} looked and reported:]`,
      ...seen.map((text, i) => (pictures.length > 1 ? `Image ${i + 1}: ${text}` : text)),
      '[End of what it saw. That is second-hand - you did not see the picture.',
      'Answer from it, and say so if what was asked needs detail it does not cover.]'
    ].join(String.fromCharCode(10))
    /* Which eye, so the turn that discovered the model is blind can say
       whose description it is about to answer from. */
    return eye
  }

  /** `asked` is the user pressing the card; `step` is the look after a plan. */
  async function shotWithNames(why: 'asked' | 'step' = 'asked'): Promise<Attachment> {
    /*
     * A model that cannot read a picture is not photographed.
     *
     * The bytes were being captured, encoded, attached, and then dropped by
     * wireMessage on the way out - because sending an image to a text-only
     * model is a 400 that costs the whole turn. So the cost was paid on this
     * machine and the model still got nothing, while the message it received
     * said a screenshot was attached and to answer from what was visible.
     *
     * The control list is the half that was always text, and it is the half
     * the acting steps use. So that is what a look returns here: names,
     * roles and centres, and `picture: false` so everything downstream knows
     * no image exists rather than finding an empty one.
     */
    /** What is on screen, by name. The half of a look that is text. */
    const visibleNames = async (): Promise<Awaited<ReturnType<typeof visibleElements>>> =>
      settings.get('browserEnabled')
        ? await visibleElements((cmd, ms) =>
            lowLevelHook
              ? lowLevelHook.send(cmd, ms)
              : Promise.resolve('ELEMENTS FAILED helper-not-running')
          )
        : { elements: [], window: '', total: 0 }

    const blind = !seesMedia(activeModel())
    if (blind) {
      const named = await visibleNames()
      /*
       * BORROWED EYES, and only when they are worth their price.
       *
       * The description costs one call to the vision model - 859ms measured,
       * no daily cap - and a desktop plan looks after every single step, so
       * paying it every time would put a second on each step to describe a
       * screen the control list already covers exactly.
       *
       * So: when the user asked to be looked at, always, because the
       * question is usually about how something looks. During a plan, only
       * when the names came back thin - an app with no accessibility tree
       * (a canvas, a remote desktop, a game, a PDF viewer) is the case where
       * a picture is not a luxury but the only information there is.
       */
      const eye = readyEye()
      const thin = named.elements.length < 5
      const described = eye && (why === 'asked' || thin) ? await lookFor(eye) : null
      console.log(
        `[wumpy] looked by name (${activeModel()} cannot read a picture): ` +
          `${named.elements.length} of ${named.total} controls in ` +
          JSON.stringify(named.window || 'an unnamed window') +
          (described ? `; ${eye?.label} described it in ${described.length} chars` : '')
      )
      return {
        kind: 'image',
        dataUrl: '',
        width: 0,
        height: 0,
        bytes: 0,
        picture: false,
        elements: named.elements,
        window: named.window,
        elementTotal: named.total,
        ...(described ? { described, describedBy: eye?.label } : {})
      }
    }
    const shot = await captureScreen(panel.liveWindow())
    console.log(`[wumpy] screen captured: ${shot.width}x${shot.height}, ${shot.bytes} bytes`)
    const named = await visibleNames()
    if (named.elements.length) {
      console.log(
        `[wumpy] ${named.elements.length} named controls in ${JSON.stringify(named.window || 'an unnamed window')}`
      )
    }
    return {
      ...shot,
      elements: named.elements,
      window: named.window,
      /* How many there are, not just how many are listed: a list of 60 out of
         673 reads as "that is everything on screen", and the model then
         concludes a button it cannot see does not exist. */
      elementTotal: named.total
    }
  }

  ipcMain.handle(IPC.screenCapture, async () => shotWithNames())

  /**
   * Open a picture the model named, after the user pressed the card.
   *
   * There is no autonomous path here either. The read itself is harmless;
   * what needs the click is that this is the one read that SENDS what it
   * reads, to a model provider, on a path the model chose. So the path is
   * on the card in the words the model wrote, and what comes back is the
   * resolved form of that same string.
   */
  ipcMain.handle(IPC.lookFile, (_e, req: { path?: string }) => lookAtFile(req?.path ?? ''))

  /**
   * Clicking and typing on the real desktop.
   *
   * The permission question was settled by the user, plainly: "My Gmail tab
   * is literally open. I'm giving it permission to do it." The refusal they
   * hit was honest - Wumpy could see the screen and could not touch it - so
   * what changed is the capability, not a prompt telling the model to claim
   * one it does not have.
   *
   * What is enforced here, where the model cannot reach it: it only runs
   * while browser control is on, it needs a screenshot to aim by, and every
   * step reports back. The rest - whether to run at all - is the approval
   * mode, like every other proposal.
   */
  ipcMain.handle(IPC.doRun, async (_e, req: { body: string }) => {
    if (!settings.get('browserEnabled')) {
      return {
        ran: [],
        refused: 'Controlling the screen is turned off in settings (browserEnabled).'
      }
    }
    const plan = readPlan(req.body)
    const result = await runPlan(plan, panel.liveWindow(), (cmd, ms) =>
      lowLevelHook
        ? lowLevelHook.send(cmd, ms)
        : Promise.resolve(`${cmd.split(' ')[0]} FAILED helper-not-running`)
    )
    /*
     * And then look again, always.
     *
     * A click whose result nobody saw is a click the model has to guess
     * about, and guessing is how the next one lands somewhere wrong. Pairing
     * every plan with a fresh screenshot makes the loop the user described -
     * look, act, look - the only loop there is.
     */
    const after =
      result.refused === null && settings.get('screenEnabled') ? await shotWithNames('step') : null
    /* Clicks and keystrokes played into somebody else's app are the thing
       in here most worth being able to look up afterwards, so the line says
       how many steps and how many of them worked. The steps themselves are
       in the card in the transcript; what the timeline needs is that it
       happened, and when. */
    if (result.refused === null && result.ran.length) {
      const ok = result.ran.filter((s) => s.ok).length
      journal.add(
        'desktop',
        ok === result.ran.length
          ? `${result.ran.length} step${result.ran.length === 1 ? '' : 's'}`
          : `${ok} of ${result.ran.length} steps worked`
      )
    }
    return { ...result, problems: plan.problems, after }
  })

  ipcMain.handle(IPC.searchRun, async (_e, query: string) => {
    if (!settings.get('searchEnabled')) {
      return { results: [], provider: 'none', error: 'Search is turned off in settings.' }
    }
    console.log(`[wumpy] searching: ${query}`)
    const result = await webSearch(query, settings.get('searchApiKey') || undefined)
    /* The same rule as the chat's own ledger: a search that errored did not
       happen, so it is not recorded as though it had. */
    if (!result.error) journal.add('search', query)
    return result
  })

  /**
   * The single place that decides what happens to a proposed command.
   *
   * The renderer asks and obeys; it never works this out for itself, so a bug
   * or a tampered page cannot widen what is permitted.
   */
  function judge(command: string): CommandVerdict {
    const scope = currentAssistant().tools
    const readOnly = isReadOnly(command)
    const allowed = scope === 'full' || (scope === 'read' && readOnly)
    const risk = assessRisk(command)
    const mode = settings.get('approvalMode')

    /**
     * Accept-all means accept all. Everything. Including the red ones.
     *
     * This was narrowed once already - from "stop for anything risky" to
     * "stop only for the severe ones" - and narrowing it again was still the
     * wrong shape of fix, because the user's answer both times was the same
     * one: "I SAID ALLOW EVERYTHING". They own the machine, they turned the
     * mode on deliberately, and a tool that keeps asking after being told
     * three times not to is not being careful, it is being disobedient.
     *
     * confirmRisky does not override it either. Leaving that as the escape
     * hatch would have meant nothing changed for someone who has it on and
     * has never heard of it, which is the user, which is everyone here.
     *
     * What is kept is the LABEL: the card is still outlined in red and still
     * says what the command does, so a destructive proposal is visible for
     * the second it sits there before it runs. Showing is not asking.
     *
     * The argument for a dialog is now entirely an argument for not using
     * this mode, and it is written down rather than enforced: with no gate
     * left, the only thing standing between a wrong guess and the machine is
     * the command the model proposes. That is where the care has to go - see
     * CLOSE_PROMPT, which exists because the first command to run under this
     * killed a tray icon the user wanted to keep.
     */
    const level = riskLevel(command)
    const risky = mode !== 'all' && level !== 'none' && settings.get('confirmRisky')
    const auto = allowed && !risky && (mode === 'all' || (mode === 'auto' && readOnly))

    return { risk, allowed, scope, auto, readOnly, level }
  }

  ipcMain.handle(IPC.shellRisk, (_e, req: { command: string }) => judge(req.command))

  /**
   * Runs a command the user approved in the panel.
   *
   * The click in the renderer is the permission gate: the model only ever emits
   * text, and nothing reaches this handler without a person pressing Run. For
   * commands that match a risky pattern there is a second, native confirmation
   * that the page cannot draw or dismiss itself.
   */
  ipcMain.handle(
    IPC.shellRun,
    async (
      _e,
      req: { command: string; shell: ShellKind; runId?: string }
    ): Promise<ShellResult | null> => {
      const command = req.command.trim()
      if (!command) return null

      // Scope is enforced here, not in the renderer and not by asking the
      // model nicely. /shell off is the only thing that turns it down now,
      // and it turns it off entirely.
      const verdict = judge(command)
      if (!verdict.allowed) {
        const scope = verdict.scope
        return {
          command,
          shell: req.shell,
          cwd: '',
          stdout: '',
          stderr:
            scope === 'read'
              ? 'Wumpy may only read right now. Turn commands back on with /shell on.'
              : 'Running commands is turned off. Turn it back on with /shell on.',
          exitCode: -1,
          durationMs: 0,
          timedOut: false,
          truncated: false,
          readOnly: verdict.readOnly
        }
      }

      if (!settings.get('shellEnabled')) {
        return {
          command,
          shell: req.shell,
          cwd: '',
          stdout: '',
          stderr: 'Running commands is turned off in settings (shellEnabled).',
          exitCode: -1,
          durationMs: 0,
          timedOut: false,
          truncated: false,
          readOnly: verdict.readOnly
        }
      }

      /**
       * The dialog follows the same rule as the verdict.
       *
       * Deciding it separately here was how accept-all ended up stopping
       * for an uninstall it had already decided to allow: judge() said run
       * it, and then this asked anyway. The mode is named explicitly as
       * well as implied through verdict.auto, so that a future change to
       * what `auto` means cannot quietly put the dialog back.
       */
      const silent =
        verdict.auto ||
        settings.get('approvalMode') === 'all' ||
        !settings.get('confirmRisky')
      const risk = silent ? null : verdict.risk
      if (risk) {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Run anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Wumpy wants to run a command',
          message: `This command ${risk}.`,
          detail: `${req.shell}

${command}`
        })
        if (response !== 1) return null
      }

      console.log(`[wumpy] running (${req.shell}): ${command}`)
      /*
       * Output goes to the card as the process writes it, not only when it
       * exits. Nothing new crosses the bridge that was not going to cross it
       * a few minutes later anyway - it just stops being a secret until then.
       */
      const runId = req.runId
      const result = await runCommand(
        command,
        req.shell,
        settings.get('shellCwd') || undefined,
        (text) => {
          if (runId) panel.send(IPC.shellProgress, { runId, text })
        }
      )
      /*
       * Recorded as it happens, by the code that ran it.
       *
       * The same reason renderer/ledger.ts exists - "I did not run
       * anything" is the worst sentence this app could produce - and here
       * as well as there, because the ledger is cleared with the chat and
       * the question is often asked a day later. A non-zero exit is kept
       * too: a command that ran and failed still ran.
       */
      journal.add(
        'command',
        result.timedOut
          ? `${command} (timed out)`
          : result.exitCode === 0
            ? command
            : `${command} (exit ${result.exitCode})`
      )
      return result
    }
  )

  /**
   * Key management, deliberately one-way.
   *
   * The renderer can ask which providers are configured, set a key, and clear
   * one. It cannot read a key back - there is no handler for that, which is
   * the point. A reply carries only whether it worked and why not.
   */
  ipcMain.handle(IPC.contextGet, () => ({
    text: notes.read(),
    path: notes.path(),
    truncated: notes.truncated()
  }))

  ipcMain.handle(IPC.contextSet, (_e, req: { text: string; append?: boolean }) => {
    const result = req?.append ? notes.add(req.text ?? '') : notes.write(req?.text ?? '')
    return { ok: result.ok, why: result.why, text: notes.read(), truncated: notes.truncated() }
  })

  ipcMain.handle(IPC.keyStatus, async () => ({
    configured: keys.configured(),
    /* Asked again when something is down, so a daemon started a moment
       ago counts now. A refused connection on localhost is instant. */
    local: await (PROVIDER_IDS.some((id) => PROVIDERS[id].keyless && !localUp.has(id))
      ? checkLocal()
      : Promise.resolve()
    ).then(() => [...localUp]),
    canStore: keys.available(),
    counts: Object.fromEntries(PROVIDER_IDS.map((id) => [id, keys.count(id)]))
  }))

  /**
   * Checks every key in a paste, not the blob.
   *
   * looksLikeKey refuses anything containing a space, which is right for one
   * key and wrong for five - and five is the point, because Gemini's free
   * tier is five requests a minute PER PROJECT.
   */
  function vetKeys(provider: ProviderId, blob: string): { ok: boolean; why: string } {
    const list = KeyStore.split(blob)
    if (!list.length) return { ok: false, why: 'No key was given.' }
    for (const [i, one] of list.entries()) {
      const verdict = looksLikeKey(provider, one)
      if (!verdict.ok) {
        return {
          ok: false,
          why: list.length > 1 ? `Key ${i + 1} of ${list.length}: ${verdict.why}` : verdict.why
        }
      }
    }
    return { ok: true, why: '' }
  }

  ipcMain.handle(IPC.keyAdd, (_e, req: { provider: ProviderId; key: string }) => {
    const provider = req?.provider
    if (!isProviderId(provider)) return { ok: false, why: 'Unknown provider.' }
    if (!keys.available()) {
      return { ok: false, why: 'This PC cannot store a key securely, so Wumpy will not store one.' }
    }
    const verdict = vetKeys(provider, req.key ?? '')
    if (!verdict.ok) return { ok: false, why: verdict.why }
    const total = keys.add(provider, req.key)
    void refreshModels()
    /* The provider and the count. NOTHING ELSE EVER: not the key, not a
       masked form of it, not its length. This boundary is one-way in the
       preload and it is one-way onto the disk too. */
    journal.add('key', `${PROVIDERS[provider].label}: added, ${total} in all`)
    return { ok: true, why: '', label: PROVIDERS[provider].label, total }
  })

  ipcMain.handle(IPC.keySet, (_e, req: { provider: ProviderId; key: string }) => {
    const provider = req?.provider
    if (!isProviderId(provider)) {
      return { ok: false, why: 'Unknown provider.' }
    }
    if (!keys.available()) {
      // Refused rather than stored in the clear. A key the user believes is
      // encrypted and is not would change which key they were willing to paste.
      return { ok: false, why: 'This PC cannot store a key securely, so Wumpy will not store one.' }
    }
    const verdict = vetKeys(provider, req.key ?? '')
    if (!verdict.ok) return { ok: false, why: verdict.why }

    keys.set(provider, req.key.trim())
    void refreshModels()
    journal.add(
      'key',
      `${PROVIDERS[provider].label}: replaced, ${keys.count(provider)} in all`
    )
    return { ok: true, why: '', label: PROVIDERS[provider].label, total: keys.count(provider) }
  })

  /**
   * Which keys still work, without spending a request to find out.
   *
   * Built after measuring this machine's own pool: three of twenty keys
   * answer 401 "the bound service account is deleted or disabled". They had
   * been in the rotation for weeks, so about one turn in seven paid a
   * request to rediscover a dead key, and the quota meter was counting a
   * ceiling that included them.
   */
  ipcMain.handle(IPC.keyCheck, async (_e, req: { provider: ProviderId }) => {
    const provider = req?.provider
    if (!isProviderId(provider)) return { ok: false, why: 'Unknown provider.', keys: [] }
    if (!keys.count(provider)) {
      return { ok: false, why: `No ${PROVIDERS[provider].label} key to check.`, keys: [] }
    }
    const results = await cloud.checkKeys(provider)
    return { ok: true, why: '', keys: results, label: PROVIDERS[provider].label }
  })

  /**
   * Drops the keys the check found dead, by position.
   *
   * The alternative was pasting the whole list again to lose three of
   * twenty, which risks the seventeen that work for the sake of the three
   * that do not.
   */
  ipcMain.handle(IPC.keyDrop, (_e, req: { provider: ProviderId; numbers: number[] }) => {
    const provider = req?.provider
    if (!isProviderId(provider)) return { ok: false, why: 'Unknown provider.' }
    const asked = Array.isArray(req?.numbers) ? req.numbers.map(Number) : []
    if (!asked.length) return { ok: false, why: 'Say which ones, by number.' }
    const before = keys.count(provider)
    const { removed, total } = keys.drop(provider, asked)
    if (!removed.length) {
      return { ok: false, why: `There ${before === 1 ? 'is' : 'are'} only ${before} key(s).` }
    }
    void refreshModels()
    journal.add(
      'key',
      `${PROVIDERS[provider].label}: dropped ${removed.map((n) => `#${n}`).join(', ')}, ` +
        `${total} left`
    )
    return { ok: true, why: '', removed, total, label: PROVIDERS[provider].label }
  })

  ipcMain.handle(IPC.keyClear, (_e, req: { provider: ProviderId }) => {
    if (!isProviderId(req?.provider)) {
      return { ok: false, why: 'Unknown provider.' }
    }
    keys.clear(req.provider)
    // A tier pointed at that provider has just become unavailable, and the
    // status bar should say so rather than failing at send time.
    void refreshModels()
    journal.add('key', `${PROVIDERS[req.provider].label}: all removed`)
    return { ok: true, why: '' }
  })

  ipcMain.on(IPC.chatAbort, (_e, requestId: string) => cloud.abort(requestId))
  ipcMain.on(IPC.panelRefocus, () => panel.forceFocus())
  ipcMain.on(IPC.panelHide, () => panel.hide('the close button'))
  ipcMain.on(IPC.panelPin, (_e, pinned: boolean) => panel.setPinned(pinned))
  ipcMain.on(IPC.panelDock, (_e, dock: Dock) => panel.setDock(dock))
  /* A page that has just loaded has no idea whether it is on screen. */
  ipcMain.handle(IPC.panelVisible, () => panel.onScreen)
  ipcMain.handle(IPC.hotkeyState, () => hotkeyState)

  /**
   * Copying, from here rather than from the page.
   *
   * The page's own clipboard needs document focus, and this window often does
   * not have it - so the Copy buttons failed silently and Ctrl+Shift+C
   * claimed success regardless. Reported by the renderer as
   * "NotAllowedError: Write permission denied". Returns whether it worked, so
   * the panel can stop saying "Copied" when it did not.
   */
  ipcMain.handle(IPC.clipboardWrite, (_e, text: string) => {
    const out = String(text ?? '')
    if (!out) return false
    try {
      clipboard.writeText(out)
      return true
    } catch (err) {
      console.warn(`[wumpy] could not write the clipboard: ${(err as Error)?.message ?? 'unknown'}`)
      return false
    }
  })

  // ---- what the user typed, for the composer's history ----
  ipcMain.handle(IPC.historyGet, () => inputHistory.all())
  ipcMain.handle(IPC.historyAdd, (_e, text: string) => inputHistory.add(text))

  // ---- saved chats ----
  ipcMain.handle(IPC.chatsList, (): ChatSummary[] => chats.list())
  ipcMain.handle(IPC.chatsLoad, (_e, id: string) => chats.load(id))
  ipcMain.handle(
    IPC.chatsSave,
    (_e, chat: { id: string; title?: string; messages: ChatMessage[] }) => chats.save(chat)
  )
  ipcMain.handle(IPC.chatsRename, (_e, id: string, title: string) => chats.rename(id, title))
  ipcMain.handle(IPC.chatsDelete, (_e, id: string) => {
    /* Counts, not titles. A conversation's title is written from its first
       message, so recording it would put a piece of what somebody said into
       a file that promises not to hold any. "Where did my chat go" is
       answered by the fact and the time. */
    if (id === '*') {
      const removed = chats.deleteAll()
      if (removed) journal.add('chat', `${removed} conversation${removed === 1 ? '' : 's'} deleted`)
      return removed
    }
    const gone = chats.delete(id)
    if (gone) journal.add('chat', 'one conversation deleted')
    return gone
  })
}

/**
 * Start Wumpy when Windows starts.
 *
 * This did nothing at all when run from source. The guard was
 * `if (!app.isPackaged) return`, written because registering the bare
 * Electron binary would start an empty Electron on login and not Wumpy. True,
 * and the wrong conclusion: the tray menu still showed a checkbox, the
 * setting still saved as on, and nothing was ever written to the Run key. The
 * user turned it on, shut down, booted, and found no tray icon — which is
 * exactly what a silently-skipped feature looks like from outside.
 *
 * The fix is to register the thing that actually works, which is the same
 * command used to start it by hand: the Electron binary WITH the app
 * directory as its first argument. A packaged build is its own executable and
 * needs no such argument.
 *
 * --hidden keeps it in the tray on login rather than opening the panel over
 * whatever Windows is still finishing.
 */
function syncLaunchAtLogin(enabled: boolean): void {
  if (process.platform === 'linux') {
    linuxAutostart(enabled)
    return
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
  })
}

/**
 * Electron's login item does nothing on Linux; desktops start what is in
 * ~/.config/autostart instead (Omarchy's session included). Written only when
 * packaged: a development checkout started at every login is not wanted.
 */
function linuxAutostart(enabled: boolean): void {
  const file = join(homedir(), '.config', 'autostart', 'wumpy.desktop')
  try {
    if (!enabled || !app.isPackaged) {
      if (existsSync(file)) unlinkSync(file)
      return
    }
    mkdirSync(dirname(file), { recursive: true })
    const exec = process.env.APPIMAGE ?? process.execPath
    writeFileSync(
      file,
      ['[Desktop Entry]', 'Type=Application', 'Name=Wumpy', `Exec="${exec}" --hidden`, 'Icon=wumpy', ''].join('\n')
    )
  } catch (err) {
    console.warn('[wumpy] could not update the autostart entry:', err)
  }
}

/* ------------------------------------------------------------------ bootup */

void app.whenReady().then(async () => {
  /* Losing the lock means this process owns nothing and shows nothing. */
  if (!isPrimary) return

  settings = new SettingsStore()
  /* Before anything reads the model: the panel, the tray and the status all
     ask for it during this same boot. */
  moveOffGoogle()
  chats = new ChatStore()
  inputHistory = new InputHistory()
  keys = new KeyStore()
  notes = new ContextStore()
  pools = new PoolStore()
  cloud = new CloudClient(keys, pools, { up: (p) => localUp.has(p), refresh: checkLocal })
  usage = new UsageStore()
  /* The panel is told about every line, so a `/log` on screen keeps up
     with the hourly ranking rather than being a snapshot of the moment it
     was asked for. `panel` is built on the next line and nothing can add a
     line before then, but the guard costs nothing and the order of this
     block is not something to depend on. */
  journal = new JournalStore(() => panel?.send(IPC.journalChanged, null))
  /* First line of every session. The gaps between these are what explain
     gaps in the timeline: Wumpy was not running. */
  journal.add('start', `version ${app.getVersion()}`)
  /* A refusal is worth a line: it is the usual reason an answer came from a
     different model than the one the status bar was showing. Repeats inside
     a minute are folded - one turn against twenty keys can produce a dozen
     of these, all of them the same fact. See QUIET_REPEATS. */
  whenLimited((provider, note) =>
    journal.add('limit', `${PROVIDERS[provider].label}: ${note || 'refused for quota'}`)
  )
  panel = new Panel(settings)

  priority = new PriorityManager(() => panel.browserWindow)

  /**
   * The background re-ranking, which is subordinate to everything.
   *
   * Asked for: one key measures the models about once an hour, the other
   * answers questions, and the measuring stops the moment the user needs
   * the account. Every rule about when it may go is in @shared/ranking;
   * what is wired here is the four things it cannot know by itself - what
   * a real preamble looks like, how many keys there are, what the user's
   * traffic is doing, and where the numbers are kept.
   */
  ranker = new Ranker({
    probe: (id, preamble, key, signal) => cloud.probeModel(id, preamble, key, signal),
    preamble: () => {
      const forProbe = currentAssistant()
      return systemPromptFor(forProbe, forProbe.tools)
    },
    state: () => {
      const provider = providerFor(activeModel())
      return {
        on: settings.get('autoRank'),
        keys: provider ? keys.count(provider) : 0
      }
    },
    traffic: () => {
      const provider = providerFor(activeModel())
      const gap = provider ? PROVIDERS[provider].minGapMs : 0
      return {
        busy: turnStartedAt !== null,
        sinceTurnMs: lastTurnEndedAt ? Date.now() - lastTurnEndedAt : Infinity,
        lastMinute: provider ? requestsInLastMinute(provider) : 0,
        /* The pacer's own ceiling rather than a second number to keep in
           step with it: minGapMs is what the app believes the account
           allows, and the ranker should believe the same thing. */
        perMinute: gap > 0 ? Math.round(60_000 / gap) : 0,
        sinceLimitedMs: provider ? sinceLimited(provider) : Infinity
      }
    },
    record: (result) => {
      /* The ledger first, because this spent one of the user's requests
         and `/usage` is where they look to find out what did. Same rule
         as `/model check`: a probe that never reached the provider is not
         a request. */
      if (spent(result.state)) {
        usage.add({
          model: result.model,
          via: result.provider || 'unknown',
          generatingMs: result.ms,
          error: !usable(result.state),
          limited: result.state === 'limited'
        })
        usage.flush()
      }
      /* Merged, never replaced: a sweep measures one model at a time and
         the other eight numbers are still the best known. */
      settings.patch({
        latencies: {
          ...settings.get('latencies'),
          ...freshLatencies([result], usage.today().date)
        }
      })
    },
    /*
     * ONE LINE PER SWEEP, written when it starts and finished in place when
     * it ends - so `/log` says when the re-ranking happened rather than
     * when it got round to the last model, and a sweep interrupted by a
     * restart still shows that it ran. Not one line per model: nine an hour
     * would be most of the history, and what each model measured is in
     * `/model`, which is where somebody looking for a number goes.
     */
    began: (sweep) => journal.add('rank', sweepOpen(sweep.asked)),
    swept: (sweep) => {
      const done = sweepLine(sweep)
      if (!journal.amend('rank', sweepOpen(sweep.asked), done)) journal.add('rank', done)
    },
    /* And the times it did not run. The reason is formatted here because
       only this side knows which model is answering, which is the cause
       nothing about the ranking mentions. */
    stoodDown: (why) => journal.add('rank', rankNote(why, modelLabel(activeModel())))
  })
  ranker.start()
  speech = new Speech()

  /**
   * Started before anyone asks for it, when dictation is turned on.
   *
   * The transcriber is a Python process holding a Whisper model, and
   * `start()` keeps it alive once it is up - so the whole cost falls on
   * the FIRST dictation of a session and none of the rest. That is the
   * worst place for it: the user has already pressed the key and is
   * already talking, and the panel sits on "Loading the speech model"
   * through the first thing they say.
   *
   * Warmed here instead, so the key press only ever pays for the
   * microphone opening. Nothing waits for it and a failure is not fatal:
   * the status it sets is the same one `voice.start()` would have set,
   * and dictation still works, just as slowly as it used to.
   *
   * Only when the setting is on. Spawning a Python process for a feature
   * nobody has enabled is not a warm-up, it is a background process
   * somebody did not ask for.
   */
  if (settings.get('voiceEnabled') && !cloudSpeech()) {
    void speech.start().then((ok) => {
      console.log(`[wumpy] speech ${ok ? 'warmed and waiting' : 'could not be started early'}`)
      panel.send(IPC.voiceStatusChanged, voiceStatus())
    })
  }

  registerIpc()
  panel.create()

  // One subprocess, once, and nothing waits for it: until it lands the facts
  // use an existence-checked guess, which is already right on an ordinary
  // machine. A folder that cannot be resolved is left out rather than stated
  // wrongly.
  void resolveUserFolders()

  const icon = nativeImage.createFromPath(resourcePath('icon.png'))
  if (!icon.isEmpty()) panel.browserWindow?.setIcon(icon)

  tray = createTray({
    panel,
    settings,
    getHotkeyState: () => hotkeyState,
    getAssistantStatus: assistantStatus,
    onToggleLaunchAtLogin: syncLaunchAtLogin,
    onRestart: () => askRestart('the tray menu')
  }) as Tray & { refresh(): void }

  applyHotkeys()
  void startLowLevelHook()
  syncLaunchAtLogin(settings.get('launchAtLogin'))

  /* Before the first status, so a model on a daemon that is not running
     is never reported ready for the half minute until the next look. */
  await checkLocal()
  setInterval(() => void checkLocal(), 30_000).unref()
  await refreshModels()

  // Launched by the login item, or by a restart during development: stay in
  // the tray instead of opening over whatever the user is doing.
  if (process.argv.includes('--voice')) startVoiceTurn('started with --voice')
  else if (!process.argv.includes('--hidden')) panel.show('launch')

  /* Last, and not awaited by anything above it: reclaiming a cache is
     housekeeping, and the panel should not wait on a disk walk to open. */
  void reclaimCache(session.defaultSession).then((held) => {
    if (held) console.log(`[wumpy] cleared ${Math.round(held / 1024 / 1024)} MB of HTTP cache`)
  })
})

/**
 * A second launch normally means "I want to see it", so the panel opens.
 *
 * Unless that launch said --hidden, which is how a restart starts now. The
 * primary is the one that decides, and it only sees the newcomer's arguments
 * here - so the flag has to be read from the event rather than from its own
 * process.argv, which belongs to a start that happened hours ago.
 */
app.on('second-instance', (_event, argv) => {
  if (argv.includes('--hidden')) return
  // `wumpy --restart`: the same restart as /restart and the tray's.
  if (argv.includes('--restart')) {
    askRestart('wumpy --restart')
    return
  }
  /* How long hearing and speaking take from here, measured without a
     sound or a microphone: see speechCheck. */
  if (argv.includes('--speech-check')) {
    void speechCheck()
    return
  }
  // A spoken turn: the earbuds gesture (through Nothing X) runs wumpy --voice.
  if (argv.includes('--voice')) {
    startVoiceTurn('wumpy --voice')
    return
  }
  // The shortcut (Super+Shift+D through a Hyprland binding on Linux).
  if (argv.includes('--toggle')) {
    panel?.toggle()
    return
  }
  panel?.show('a second Wumpy was started')
})

/**
 * Restarting, from /restart, the tray, `wumpy --restart`, or "restart
 * yourself" through the earbuds.
 *
 * Asked for by name: "add a restart command". Until now a restart meant
 * killing the process by its PID and starting it again by hand, which is
 * what an update or a stuck model actually needs and nobody should have to
 * know how to do.
 *
 * It comes back as it was: on the chat it left (saved first, by the panel,
 * which is the one that holds it), and with the panel on screen only if it
 * was on screen. A restart from a voice turn, with the panel hidden, stays
 * hidden. app.relaunch starts the new copy as this one exits, so the
 * single-instance lock has been let go by the time it asks for it.
 *
 * Through app.quit rather than app.exit, so will-quit runs and the day's
 * counts are flushed; the music is resumed first and awaited, because
 * will-quit cannot wait for it and a restart in the middle of a voice turn
 * would otherwise leave the song paused for good.
 */
let restarting = false
/** The chat a restart left, from --resume-chat=<id>. Taken once. */
let launchChat: string | null =
  process.argv.find((a) => a.startsWith('--resume-chat='))?.slice('--resume-chat='.length) ?? null
if (launchChat && !/^[\w-]{1,80}$/.test(launchChat)) launchChat = null

/** Wumpy's own launch flags, which describe one start and are not carried over. */
const OWN_FLAGS = /^--(?:hidden|voice|toggle|restart|speech-check|resume-chat=.*)$/

async function restartWumpy(why: string, chatId: string | null): Promise<void> {
  if (restarting) return
  restarting = true
  clearTimeout(restartFallback)
  console.log(`[wumpy] restarting: ${why}`)
  journal?.add('start', `restarting (${why})`)
  const args = process.argv.slice(1).filter((a) => !OWN_FLAGS.test(a))
  if (!panel?.onScreen) args.push('--hidden')
  if (chatId && /^[\w-]{1,80}$/.test(chatId)) args.push(`--resume-chat=${chatId}`)
  await releaseAllMusic().catch(() => undefined)
  app.relaunch({ args })
  app.quit()
}

/**
 * A restart that did not start in the panel: the panel is asked to do it,
 * so the chat is saved and named on the way out. If it does not answer -
 * and a panel that has stopped answering is one reason to restart - it
 * happens anyway, on an empty chat rather than not at all.
 */
let restartFallback: ReturnType<typeof setTimeout> | undefined
function askRestart(why: string): void {
  const contents = panel?.browserWindow?.webContents
  if (!contents || contents.isLoading() || contents.isCrashed()) {
    void restartWumpy(why, null)
    return
  }
  panel.send(IPC.appRestartAsked, why)
  clearTimeout(restartFallback)
  restartFallback = setTimeout(() => void restartWumpy(`${why}, without the panel`, null), 4000)
}

/**
 * Asks the panel to run a spoken turn: listen, answer out loud, ask for any
 * approval out loud too.
 *
 * In the background again, now that it works. For a while it brought the
 * window up ("make the process something I can see, not a background
 * process"), which is how the real faults were found: a recorder that heard
 * nothing on another workspace, and an answer the page refused to play.
 * With both fixed: "now allow the wumpy to run in the background, now that
 * it works." The voice bar (VoiceTurnBar) still shows every stage whenever
 * the window is open, and every stage is still in wumpy.log.
 *
 * At a cold start the page may still be loading, and a message sent to a page
 * that has not subscribed yet is simply lost; so it waits for the load, and a
 * moment for the app to mount.
 */
/**
 * `wumpy --speech-check`: how long Magpie takes from this machine, on this
 * network, written to the log. Nothing is played and no microphone opens -
 * it measures the connection, a short answer the plain way and streamed,
 * and the first sound of a longer one. Four requests on the speech keys.
 *
 * Here because the time between an answer arriving and hearing it is
 * mostly network, and that differs between a desk and a phone's hotspot.
 */
async function speechCheck(): Promise<void> {
  if (!cloudSpeech()) {
    console.log('[wumpy] speech check: hosted speech is off or has no key')
    return
  }
  const voice = settings.get('speakVoice') || DEFAULT_VOICE
  closeSpeech()
  console.log(`[wumpy] speech check: connected in ${await warmSpeech()}ms`)
  const timed = async (label: string, run: (k: NonNullable<Awaited<ReturnType<typeof cloud.speechKey>>>) => Promise<string>): Promise<void> => {
    const borrowed = await cloud.speechKey('magpie')
    if (!borrowed) {
      console.log(`[wumpy] speech check: ${label}: no key free`)
      return
    }
    const started = Date.now()
    try {
      console.log(`[wumpy] speech check: ${label}: ${await run(borrowed)}`)
    } catch (err) {
      console.log(`[wumpy] speech check: ${label}: failed after ${Date.now() - started}ms (${String(err)})`)
    }
  }
  await timed('"Five." in one piece', async (k) => `${(await synthesize('Five.', k, voice)).ms}ms`)
  await timed('"Five." streamed', async (k) => {
    const r = await synthesizeStream('Five.', k, voice, () => {})
    return `first sound ${r.firstMs}ms, all ${r.ms}ms, ${r.pieces} pieces${r.streamed ? '' : ' (not streamed)'}`
  })
  const long =
    'Your disk is about two thirds full, with roughly ninety gigabytes free, so there is plenty of room for now.'
  await timed('a long sentence in one piece', async (k) => `${(await synthesize(long, k, voice)).ms}ms`)
  await timed('a long sentence streamed', async (k) => {
    const r = await synthesizeStream(long, k, voice, () => {})
    return `first sound ${r.firstMs}ms, all ${r.ms}ms, ${r.pieces} pieces${r.streamed ? '' : ' (not streamed)'}`
  })
  /* And hearing, the other half of the wait: the long sentence as Magpie
     said it, back through Parakeet at the rate the panel sends - how long a
     transcript takes once the last word is in, and whether it came back
     right. Twice, since the first request on a channel can be the slow one. */
  const said = await (async () => {
    const k = await cloud.speechKey('magpie')
    return k ? synthesize(long, k, voice).catch(() => null) : null
  })()
  const clip = said ? pcmFromWav(said.wav) : null
  if (!clip) {
    console.log('[wumpy] speech check: hearing: no sentence to hear')
    return
  }
  const wav = wavFrom(downsample(clip.pcm, clip.sampleRate, 16000), 16000)
  const hearIt = async (label: string): Promise<void> => {
    const k = await cloud.speechKey('parakeet')
    if (!k) {
      console.log(`[wumpy] speech check: ${label}: no key free`)
      return
    }
    const started = Date.now()
    try {
      const r = await recognize(wav, k)
      const right = r.text.toLowerCase().replace(/[^a-z ]/g, '') === long.toLowerCase().replace(/[^a-z ]/g, '')
      console.log(
        `[wumpy] speech check: ${label}: ${r.ms}ms for ${r.audioSeconds.toFixed(1)}s of speech, ` +
          `${right ? 'word for word' : `as "${r.text}"`}`
      )
    } catch (err) {
      console.log(`[wumpy] speech check: ${label}: failed after ${Date.now() - started}ms (${String(err)})`)
    }
  }
  /* On a fresh connection, then on another fresh one primed the way a voice
     turn primes it (see coldSpeech) - the difference is what priming saves. */
  closeSpeech()
  await warmSpeech()
  await hearIt('hearing it, on a fresh connection')
  closeSpeech()
  await warmSpeech()
  console.log(`[wumpy] speech check: priming: ${await primeSpeech()}`)
  await hearIt('hearing it, primed')
}

/*
 * The slow first request on a connection (see coldSpeech in nvspeech), spent
 * while the person is still talking: a voice turn's transcript and its first
 * spoken word each wait on one otherwise. A service that answered within the
 * last minute is warm and left alone, so this costs a request only when it
 * saves one's worth of waiting.
 */
async function primeSpeech(): Promise<string> {
  const cold = coldSpeech()
  const one = async (what: string, run: (k: NonNullable<Awaited<ReturnType<typeof cloud.speechKey>>>) => Promise<number>): Promise<string> => {
    const k = await cloud.speechKey(what === 'hearing' ? 'parakeet' : 'magpie')
    if (!k) return `${what}: no key free`
    try {
      return `${what} in ${await run(k)}ms`
    } catch (err) {
      return `${what} failed (${String(err)})`
    }
  }
  const jobs = [
    cold.hear ? one('hearing', primeHearing) : null,
    cold.talk ? one('talking', (k) => primeTalking(k, settings.get('speakVoice') || DEFAULT_VOICE)) : null
  ].filter((j): j is Promise<string> => j !== null)
  return jobs.length ? (await Promise.all(jobs)).join(', ') : 'both warm already'
}

/** 16-bit mono PCM at another rate, by straight-line interpolation: plenty for a recogniser. */
function downsample(pcm: Buffer, from: number, to: number): Buffer {
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1)
  const out = new Int16Array(Math.floor((input.length * to) / from))
  for (let i = 0; i < out.length; i++) {
    const at = (i * from) / to
    const j = Math.floor(at)
    const next = input[Math.min(j + 1, input.length - 1)]
    out[i] = Math.round(input[j] + (next - input[j]) * (at - j))
  }
  return Buffer.from(out.buffer)
}

function startVoiceTurn(why: string): void {
  const contents = panel?.browserWindow?.webContents
  if (!contents) return
  console.log(`[wumpy] voice turn: ${why}`)
  /* The connections to Parakeet and Magpie, opened while the person talks,
     so neither the transcript nor the first spoken word waits on one. */
  if (cloudSpeech()) {
    void warmSpeech().then((ms) => {
      if (ms >= 0) console.log(`[wumpy] speech connections ready in ${ms}ms`)
    })
    void primeSpeech().then((how) => console.log(`[wumpy] speech primed: ${how}`))
  }
  if (contents.isLoading()) {
    contents.once('did-finish-load', () => setTimeout(() => panel.send(IPC.voiceTurn, null), 900))
    return
  }
  panel.send(IPC.voiceTurn, null)
}

app.on('will-quit', () => {
  void releaseAllMusic()
  unregisterHotkeys()
  lowLevelHook?.stop()
  speech?.stop()
  closeSpeech()
  /*
   * The two ledgers, in case this is the one exit that gets a say.
   *
   * It usually is not - `npm run restart` is `Stop-Process -Force`, and
   * nothing runs after that - which is why both stores now write the
   * expensive parts as they happen rather than relying on this. Quitting
   * from the tray does come through here, though, and there is no reason to
   * lose the last turn's counts on the one orderly exit there is.
   */
  pools?.flush()
  usage?.flush()
})

/**
 * Live facts, handed to the model every turn.
 *
 * A model has no clock, no idea which chat it is in and no view of the app
 * around it, so without this it either guesses or refuses. Telling it is
 * nearly free and removes a whole class of confident wrong answers.
 */
function withContext(req: ChatRequest): Array<Pick<ChatMessage, 'role' | 'content' | 'images'>> {
  const facts = factsFor(
    req.context.chatTitle,
    req.context.actions ?? [],
    req.context.handsFree === true
  )

  /*
   * Only the newest screenshots go out, which was costing a fortune.
   *
   * Every image in the conversation was attached to every request. Fine while
   * a picture was something the user occasionally pasted; quadratic once each
   * step of a desktop plan returns one - fifty-five pictures over a ten-step
   * sequence, around 60,000 tokens of photographs for ten pictures' worth of
   * information, on a tier metered per minute and per day.
   *
   * Done here rather than in the renderer on purpose: the transcript keeps
   * every picture it ever showed, because that is the user's record of what
   * was sent on their behalf. This is only the wire.
   */
  const messages: Array<Pick<ChatMessage, 'role' | 'content' | 'images'>> = trimPictures(
    req.messages.map((m) => ({ role: m.role, content: m.content, images: m.images }))
  )
  // Directly behind the latest user turn, so everything before it stays cached.
  //
  // Moving it in front of the conversation instead looks like it should be
  // cheaper — it would stop sliding one message further along each turn, and so
  // stop the previous answer landing after the point where the cache diverges.
  // Measured over a three-turn conversation, it makes no difference at all:
  // 0.92s and 0.94s of prefill on turns two and three where it is, against
  // 0.90s and 0.87s in front. Not worth the re-prefill it would cost each time
  // a chat is named.
  messages.splice(Math.max(0, messages.length - 1), 0, { role: 'system', content: facts })
  return messages
}
