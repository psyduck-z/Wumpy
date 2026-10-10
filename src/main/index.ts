import { app, dialog, ipcMain, nativeImage, Tray } from 'electron'
import { homedir } from 'node:os'
import { IPC } from '@shared/types'
import type {
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
  WumpySettings
} from '@shared/types'
import {
  DEFAULT_MODEL,
  assistantFor,
  SHELL_PROMPT,
  READ_SHELL_PROMPT,
  NO_SHELL_PROMPT,
  APP_PROMPT,
  ASK_PROMPT,
  SEARCH_PROMPT,
  OPEN_PROMPT
} from '@shared/assistant'
import { SettingsStore } from './store'
import { ChatStore } from './chats'
import { InputHistory } from './history'
import { CloudClient } from './cloud'
import { KeyStore } from './keys'
import { UsageStore } from './usage'
import { Panel } from './panel'
import { createTray, resourcePath } from './tray'
import { registerHotkeys, unregisterHotkeys } from './hotkey'
import { LowLevelHook } from './lowlevelhook'
import { runCommand, assessRisk, isReadOnly } from './shell'
import { PriorityManager } from './priority'
import { webSearch } from './search'
import { cleanTitle, titleBrief, titleSource } from '@shared/titles'
import { folderFacts, resolveUserFolders } from './folders'
import { Speech } from './speech'
import { openLink, openSearch } from './browser'
import { inspectWriteTarget, writeProposedFile } from './writefile'
import {
  PROVIDERS,
  isCloudModel,
  isProviderId,
  looksLikeKey,
  PROVIDER_IDS,
  providerFor,
  siblingModel
} from '@shared/cloud'
import type { ProviderId } from '@shared/cloud'
import { checkLink, isSearchEngine } from '@shared/links'
import { POLISH_PROMPT, polishAcceptable, tidyTranscript } from '@shared/dictation'

// Only one Wumpy may own the tray icon and the global hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setAppUserModelId('dev.psyduckz.wumpy')
// Registering any handler here overrides Electron's quit-on-last-window
// behaviour, which is what keeps Wumpy alive in the tray with no window open.
app.on('window-all-closed', () => {})

let settings: SettingsStore
let chats: ChatStore
let inputHistory: InputHistory
let cloud: CloudClient
let keys: KeyStore
let usage: UsageStore
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

async function refreshModels(): Promise<void> {
  panel.send(IPC.assistantStatus, assistantStatus())
  tray?.refresh()
}

/**
 * The live facts block, built in exactly one place.
 *
 * Deliberately no clock time and no message count. Both changed on every turn
 * and bought nothing, while making this block differ each time.
 */
function factsFor(chatTitle: string | null, actions: string[] = []): string {
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
    `- The user is on Windows. Commands run from ${settings.get('shellCwd') || homedir()}.`,
    // Resolved by asking Windows at startup, not guessed. Documents,
    // Pictures and Desktop are redirected to OneDrive here, and the model
    // guessed $env:USERPROFILE\Documents - which returned an empty stdout
    // and an empty stderr, so the wrong folder was indistinguishable from
    // an empty one.
    ...folderFacts(),
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
/** A blank line between prompt sections, built without an escape sequence. */
const SECTION_GAP = String.fromCharCode(10, 10)

function systemPromptFor(assistant: Assistant, scope: 'none' | 'read' | 'full'): string {
  return [
    assistant.systemPrompt,
    APP_PROMPT,
    scope === 'full' ? SHELL_PROMPT : scope === 'read' ? READ_SHELL_PROMPT : NO_SHELL_PROMPT,
    scope !== 'none' && settings.get('searchEnabled') ? SEARCH_PROMPT : '',
    scope !== 'none' && settings.get('browserEnabled') ? OPEN_PROMPT : '',
    ASK_PROMPT
  ]
    .filter(Boolean)
    .join(SECTION_GAP)
}

/**
 * The assistant as currently configured.
 *
 * Built per turn rather than held as a constant because the two things that
 * shape it - which model, and whether shell is on - are settings the user can
 * change between questions.
 */
function currentAssistant(): Assistant {
  return assistantFor(activeModel(), settings.get('shellEnabled'))
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
 * Claims Win+C through the helper process. RegisterHotKey cannot take it
 * because the shell holds it for Copilot, so we intercept it a layer lower.
 */
async function startLowLevelHook(): Promise<void> {
  lowLevelHook = new LowLevelHook('C', () => panel.toggle())
  const ok = await lowLevelHook.start()
  hotkeyState.intercepted = ok ? 'Super+C' : null
  if (!ok) {
    lowLevelHook = null
    console.warn('[wumpy] Win+C interception unavailable; use the tray icon')
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

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<WumpySettings>) => {
    const next = settings.patch(patch)
    if (patch.hotkeys) applyHotkeys()
    if (patch.tallWidth || patch.compactWidth || patch.compactHeight) panel.applyGeometry()
    if (patch.launchAtLogin !== undefined) syncLaunchAtLogin(patch.launchAtLogin)
    if (patch.model) void refreshModels()
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
    const systemPrompt = systemPromptFor(assistant, scope)

    // Stand aside for the duration of the turn: tokens matter more than UI.
    priority.yieldToModel()

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

    async function attempt(on: string, announce: string | null): Promise<string | null> {
      let streamed = false
      let fallbackTo: string | null = null

      if (announce) {
        panel.send(IPC.chatDelta, { requestId: req.requestId, content: announce })
      }

      await cloud.chat(
        req.requestId,
        on,
        withContext(req),
        {
          thinking: assistant.thinking,
          options: assistant.options,
          maxTurnMs: settings.get('maxTurnMs'),
          systemPrompt
        },
        {
          onDelta: (delta) => {
            if (delta.content || delta.thinking) streamed = true
            panel.send(IPC.chatDelta, { requestId: req.requestId, ...delta })
          },
          onDone: (stats) => {
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
            usage.add({
              model: on,
              via: providerFor(on) ?? 'unknown',
              error: true,
              limited: failure?.kind === 'limit',
              // "Out for the day" rather than "slow down": the request count
              // at this moment is the only cap figure anyone here can trust,
              // since the published ones contradict each other.
              exhausted: failure?.kind === 'limit' && /quota|used up|free quota/i.test(message)
            })

            if (failure?.kind === 'limit' && /used up its free requests/.test(message)) {
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
      return fallbackTo
    }

    const fallback = await attempt(model, null)
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
  })

  ipcMain.handle(IPC.usageGet, () => ({
    lines: usage.lines(),
    model: activeModel(),
    date: usage.today().date
  }))

  ipcMain.handle(IPC.usageReset, () => {
    usage.reset()
    return { lines: usage.lines(), model: activeModel(), date: usage.today().date }
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
    return writeProposedFile(req.path, req.content, settings.get('shellCwd') || homedir())
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
    return openLink(raw)
  })

  ipcMain.handle(IPC.linkSearch, async (_e, query: string) => {
    if (!settings.get('browserEnabled')) {
      return { opened: false, url: '', host: '', error: 'Opening pages is turned off in settings.' }
    }
    const engine = settings.get('searchEngine')
    return openSearch(query, isSearchEngine(engine) ? engine : 'duckduckgo')
  })

  /** What the panel needs to describe a link before anything is opened. */
  ipcMain.handle(IPC.linkCheck, (_e, raw: string) => checkLink(raw))

  /* ------------------------------------------------------------------- voice */

  ipcMain.handle(IPC.voiceStatus, () => speech.status())

  // Starting the transcriber loads a model, so it is done when the panel asks
  // rather than at launch: someone who never dictates never pays for it.
  ipcMain.handle(IPC.voiceStart, async () => {
    await speech.start()
    const status = speech.status()
    panel.send(IPC.voiceStatusChanged, status)
    return status
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
      const clip = await speech.transcribe(new Uint8Array(req.audio), req.extension ?? 'webm')
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
   * Runs a web search the user approved. Like commands, the query leaves this
   * machine only after a click: a model can put anything in it, including
   * whatever it has just read.
   */
  ipcMain.handle(IPC.searchRun, async (_e, query: string) => {
    if (!settings.get('searchEnabled')) {
      return { results: [], provider: 'none', error: 'Search is turned off in settings.' }
    }
    console.log(`[wumpy] searching: ${query}`)
    return webSearch(query, settings.get('searchApiKey') || undefined)
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

    // Risky commands never run unprompted while confirmRisky stands, whatever
    // the mode: the model wrote them, and a wrong path does not come back.
    const risky = risk !== null && settings.get('confirmRisky')
    const auto = allowed && !risky && (mode === 'all' || (mode === 'auto' && readOnly))

    return { risk, allowed, scope, auto, readOnly }
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
    async (_e, req: { command: string; shell: ShellKind }): Promise<ShellResult | null> => {
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

      // A risky command still raises the dialog even when the mode would have
      // run it, unless the user has explicitly turned that off.
      const risk = settings.get('confirmRisky') ? verdict.risk : null
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
      return runCommand(command, req.shell, settings.get('shellCwd') || undefined)
    }
  )

  /**
   * Key management, deliberately one-way.
   *
   * The renderer can ask which providers are configured, set a key, and clear
   * one. It cannot read a key back - there is no handler for that, which is
   * the point. A reply carries only whether it worked and why not.
   */
  ipcMain.handle(IPC.keyStatus, () => ({
    configured: keys.configured(),
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
    return { ok: true, why: '', label: PROVIDERS[provider].label, total: keys.count(provider) }
  })

  ipcMain.handle(IPC.keyClear, (_e, req: { provider: ProviderId }) => {
    if (!isProviderId(req?.provider)) {
      return { ok: false, why: 'Unknown provider.' }
    }
    keys.clear(req.provider)
    // A tier pointed at that provider has just become unavailable, and the
    // status bar should say so rather than failing at send time.
    void refreshModels()
    return { ok: true, why: '' }
  })

  ipcMain.on(IPC.chatAbort, (_e, requestId: string) => cloud.abort(requestId))
  ipcMain.on(IPC.panelRefocus, () => panel.forceFocus())
  ipcMain.on(IPC.panelHide, () => panel.hide())
  ipcMain.on(IPC.panelPin, (_e, pinned: boolean) => panel.setPinned(pinned))
  ipcMain.on(IPC.panelDock, (_e, dock: Dock) => panel.setDock(dock))
  ipcMain.handle(IPC.hotkeyState, () => hotkeyState)

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
  ipcMain.handle(IPC.chatsDelete, (_e, id: string) =>
    id === '*' ? chats.deleteAll() : chats.delete(id)
  )
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
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
  })
}

/* ------------------------------------------------------------------ bootup */

void app.whenReady().then(async () => {
  settings = new SettingsStore()
  chats = new ChatStore()
  inputHistory = new InputHistory()
  keys = new KeyStore()
  cloud = new CloudClient(keys)
  usage = new UsageStore()
  panel = new Panel(settings)

  priority = new PriorityManager(() => panel.browserWindow)
  speech = new Speech()

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
    onToggleLaunchAtLogin: syncLaunchAtLogin
  }) as Tray & { refresh(): void }

  applyHotkeys()
  void startLowLevelHook()
  syncLaunchAtLogin(settings.get('launchAtLogin'))

  await refreshModels()

  // Launched by the login item: stay in the tray instead of popping up.
  if (!process.argv.includes('--hidden')) panel.show()
})

app.on('second-instance', () => panel?.show())

app.on('will-quit', () => {
  unregisterHotkeys()
  lowLevelHook?.stop()
  speech?.stop()
})

/**
 * Live facts, handed to the model every turn.
 *
 * A model has no clock, no idea which chat it is in and no view of the app
 * around it, so without this it either guesses or refuses. Telling it is
 * nearly free and removes a whole class of confident wrong answers.
 */
function withContext(req: ChatRequest): Array<Pick<ChatMessage, 'role' | 'content'>> {
  const facts = factsFor(req.context.chatTitle, req.context.actions ?? [])

  const messages: Array<Pick<ChatMessage, 'role' | 'content'>> = [
    ...req.messages.map((m) => ({ role: m.role, content: m.content }))
  ]
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
