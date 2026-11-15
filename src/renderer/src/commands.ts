import type { Dock, ProviderName } from '@shared/types'
import { PROVIDER_IDS, PROVIDERS, isProviderId } from '@shared/cloud'
import { MAX_RUNS } from '@shared/probe'
import { readOrdering, type Ordering } from '@shared/order'
import { readKind, type EventKind } from '@shared/journal'
import { nearest } from '@shared/nearest'
import { markLines } from './kinds'
import { APP_WINDOW, PANEL_ONLY_COMMANDS } from './appwindow'

/**
 * What a command asks the app to do. Commands are parsed in the renderer and
 * dispatched as plain data, so the composer never needs to know what any of
 * them mean.
 */
export type CommandAction =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string }
  | { kind: 'new' }
  /** Hand the model a photograph of the screen, without it having to ask. */
  | { kind: 'screen'; ask: string }
  | { kind: 'chats' }
  | { kind: 'resume' }
  /**
   * No argument deletes the chat you are in; `/delete pick` opens the list.
   *
   * `confirm` asks first, which typing `/delete` never does - but asking
   * for it in words, or through the earbuds, or the model proposing it, is
   * not the same as typing it, and those ask. `confirmed` is the answer
   * having been yes. `chatId` is a chat other than the one open, picked
   * from the list out loud.
   */
  | { kind: 'delete'; pick: boolean; confirm?: boolean; confirmed?: boolean; chatId?: string }
  | { kind: 'rename'; title: string }
  | { kind: 'renameChoice'; question: string; options: string[] }
  | { kind: 'model'; name: string }
  /**
   * `/model check [runs]` — ask every model whether it answers, `runs`
   * times each. Undefined means DEFAULT_RUNS.
   */
  | { kind: 'models'; runs?: number }
  /**
   * `/model smarts` - which question the list is sorted on, and open it.
   *
   * A setting rather than a sort applied once, so it is a command of its
   * own kind rather than an argument to the picker: the tabs remember.
   */
  | { kind: 'modelorder'; ordering: Ordering }
  | { kind: 'dock'; dock: Dock | null }
  | { kind: 'reasoning'; show: boolean | 'toggle' }
  | { kind: 'pin'; pinned: boolean | 'toggle' }
  | { kind: 'voice'; setting: 'on' | 'polish' | 'autostop' | 'music'; on: boolean | 'toggle' }
  | { kind: 'reflect'; on: boolean | 'toggle'; rounds?: number; model?: string }
  /** Listening to the machine's own audio. See @shared/meeting. */
  | { kind: 'listen'; what: 'toggle' | 'stop' | 'notes' | 'source'; ask: string }
  /** A plain boolean in the settings file, with no machinery behind it. */
  | { kind: 'setting'; setting: 'leanPrompt' | 'thinking'; on: boolean | 'toggle' }
  | { kind: 'open'; what: string }
  | { kind: 'engine' }
  /** What everything is set to, with the command that changes each. */
  | { kind: 'settings' }
  /**
   * The background re-ranking. No argument reports; on|off sets; now
   * starts a sweep without waiting for the hour.
   */
  | { kind: 'rank'; set: boolean | null; now: boolean }
  | {
      kind: 'key'
      provider: ProviderName | null
      value: string
      clear: boolean
      add: boolean
      /** `/key google check` - are they all still good? */
      check?: boolean
      /** `/key google drop 1 2 3` - remove these by position. */
      drop?: number[]
    }
  /**
   * `/key <provider> accounts separate|shared` — are these keys one account
   * or several? Null reports rather than sets. See WumpySettings.keyAccounts.
   */
  | { kind: 'accounts'; provider: ProviderName; mode: 'shared' | 'separate' | null }
  | { kind: 'remember'; value: string; clear: boolean }
  | { kind: 'usage'; reset: boolean }
  /**
   * `/log` — what Wumpy has done, with the time.
   *
   * Called 'journal' here and `/log` out there, because the app already has
   * a thing called the log - wumpy.log, the debugging file - and the two
   * must not be confused in the source even though `/log` is the word
   * somebody reaches for. See @shared/journal.
   */
  | { kind: 'journal'; all: boolean; clear: boolean; only: EventKind | null }
  | { kind: 'approve'; mode: 'manual' | 'auto' | 'all' | 'cycle' }
  | { kind: 'compact' }
  | { kind: 'stop' }
  | { kind: 'help' }
  /**
   * `/shortcuts` — the keys, on their own.
   *
   * They were inside /help, under sixty rows of commands, which is a long
   * way to scroll for the one table nobody can memorise. Asked for by name:
   * "add a new command to see all of the shortcuts".
   *
   * NOT called 'keys', here or out there, and that is not fussiness. `/key`
   * takes a secret, and the guard that keeps those out of input history
   * matches on the first word - so `/keys nvidia <secret>`, one letter
   * wrong, would have printed this table and written the key to a plain file
   * that comes back on one press of Up. Two commands a character apart, one
   * of them handling secrets, is not a namespace worth having.
   */
  | { kind: 'shortcuts' }
  | { kind: 'quit' }
  /** Send to the model, but wrapped in a prompt that shapes the answer. */
  | { kind: 'prompt'; text: string; label: string }

export interface CommandSpec {
  name: string
  aliases?: string[]
  /** Shown in the palette. */
  hint: string
  /** `<name>` style placeholder shown after the command when it takes an argument. */
  arg?: string
  /**
   * Whether the bare command is useless without its argument.
   *
   * Most of the ones that take an argument do something worth doing without
   * it: `/model` opens the picker, `/usage` shows the report, `/pin` toggles.
   * Enter on those should RUN them. Reported as "you have to press enter and
   * then enter again" — the palette treated every argument as required, so
   * `/model` completed to `/model ` with a trailing space and waited for a
   * name nobody wanted to type.
   *
   * Only `/rename`, `/open` and `/key` genuinely need one; bare, each
   * answers with its own usage line. Those keep the old behaviour.
   */
  argRequired?: boolean
  /**
   * May be offered as a button bare, and never with an argument.
   *
   * One command so far, and it earns the field. `/log` is worth clicking -
   * it is the answer to "when did that happen" - but `/log clear` destroys
   * the record of what the app did, and CLICKABLE exists precisely because
   * an answer is model output and this app feeds the model web pages. A
   * page that can get `/log clear` rendered as a button can get the
   * receipt erased in one click, which is the first thing worth planting in
   * one. Typed out, it is the user's own hand.
   */
  clickBareOnly?: boolean
  run(arg: string): CommandAction
}

const DOCKS: Dock[] = ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']
/**
 * Prompt wrappers. These are the "commands Claude has" that a plain chat box
 * does not: they reshape the request rather than issuing an app action.
 */
const PROMPT_COMMANDS: Array<{
  name: string
  hint: string
  label: string
  wrap(t: string): string
}> = [
  {
    name: 'plan',
    hint: 'Plan the approach before writing anything',
    label: 'plan',
    wrap: (t) =>
      `Produce a short implementation plan for the following. Number the steps, ` +
      `name the files or commands each step touches, and call out anything risky ` +
      `or ambiguous. Do not write the full solution yet.\n\n${t}`
  },
  {
    name: 'btw',
    hint: 'Quick aside — answer in one line, no preamble',
    label: 'btw',
    wrap: (t) => `Answer in a single short line. No preamble, no caveats.\n\n${t}`
  },
  {
    name: 'explain',
    hint: 'Explain it plainly, with a concrete example',
    label: 'explain',
    wrap: (t) =>
      `Explain the following clearly, assuming a competent engineer who is new to ` +
      `this specific thing. Include one concrete example.\n\n${t}`
  },
  {
    name: 'fix',
    hint: 'Diagnose an error and give the corrected code',
    label: 'fix',
    wrap: (t) =>
      `Diagnose this problem. State the root cause in one sentence, then give the ` +
      `corrected code. Do not restate the original code unchanged.\n\n${t}`
  },
  {
    name: 'review',
    hint: 'Review code for real bugs, not style',
    label: 'review',
    wrap: (t) =>
      `Review the following for correctness bugs, edge cases and failure modes. ` +
      `Ignore formatting and style. If you find nothing real, say so plainly.\n\n${t}`
  },
  {
    name: 'cmd',
    hint: 'Give just the command line, nothing else',
    label: 'cmd',
    wrap: (t) =>
      `Give only the command line that does this, in a fenced code block, with a ` +
      `one-line explanation beneath it. Target Windows PowerShell unless told ` +
      `otherwise.\n\n${t}`
  }
]

function bool(arg: string, fallback: boolean | 'toggle' = 'toggle'): boolean | 'toggle' {
  const a = arg.trim().toLowerCase()
  if (['on', 'yes', 'true', 'show', '1'].includes(a)) return true
  if (['off', 'no', 'false', 'hide', '0'].includes(a)) return false
  return fallback
}

/**
 * The commands this window has. /dock and /pin move and float the overlay
 * panel, and on Omarchy, where Wumpy is an ordinary window, there is no panel
 * to move: they are left out of the palette and the menu rather than offered
 * and then doing nothing. See appwindow.ts.
 */
function forThisWindow(all: CommandSpec[]): CommandSpec[] {
  return APP_WINDOW ? all.filter((c) => !PANEL_ONLY_COMMANDS.has(c.name)) : all
}

export const COMMANDS: CommandSpec[] = forThisWindow([
  {
    name: 'new',
    aliases: ['clear', 'reset'],
    hint: 'Start a fresh chat',
    run: () => ({ kind: 'new' })
  },
  {
    name: 'screen',
    aliases: ['see', 'look', 'shot'],
    /*
     * The short way round.
     *
     * Showing the model the screen took three turns: ask it something, have
     * it propose a wumpy-screen block, let that capture, and only then get
     * an answer. "Make it easier way... for the model to see what's on my
     * screen." This is one keystroke: the picture goes with whatever is in
     * the box, or on its own.
     */
    hint: 'Show the model your screen  (/screen what is this error)',
    run: (arg) => ({ kind: 'screen', ask: (arg ?? '').trim() })
  },
  {
    name: 'resume',
    aliases: ['r'],
    // No argument on purpose: the picker has its own search box and arrow-key
    // selection, so Enter should open it rather than wait for a name.
    hint: 'Pick up a previous chat (Ctrl+R)',
    run: () => ({ kind: 'resume' })
  },
  {
    name: 'chats',
    aliases: ['history', 'list'],
    hint: 'Browse saved chats',
    run: () => ({ kind: 'chats' })
  },
  {
    name: 'delete',
    aliases: ['rm'],
    /*
     * The chat you are in, with no list in the way.
     *
     * It used to open the same picker as /resume, so deleting the thing in
     * front of you meant opening a list, finding it among the others and
     * picking it - "just slash delete means you delete the current chat.
     * You don't have to go to the UI page thing to make it easier."
     *
     * The list is still there for deleting a different one, behind an
     * argument rather than in the way of the common case.
     */
    hint: 'Delete this chat  (/delete pick for the list)',
    run: (arg) => ({ kind: 'delete', pick: /^(pick|list|other|choose)$/i.test((arg ?? '').trim()) })
  },
  {
    name: 'rename',
    aliases: ['title'],
    hint: 'Retitle this chat (chats save themselves)',
    arg: 'title',
    argRequired: true,
    run: (arg) =>
      arg.trim()
        ? { kind: 'rename', title: arg.trim() }
        : { kind: 'error', message: 'Usage: /rename <title>' }
  },
  {
    name: 'dock',
    aliases: ['move', 'pos'],
    hint: 'Move the panel: left | right | top-right | …',
    arg: 'position',
    run: (arg) => {
      if (!arg.trim()) return { kind: 'dock', dock: null }
      const a = arg.trim().toLowerCase().replace(/\s+/g, '-')
      const dock = DOCKS.find((d) => d === a)
      if (!dock) {
        return { kind: 'error', message: `Unknown position. Try: ${DOCKS.join(', ')}` }
      }
      return { kind: 'dock', dock }
    }
  },
  {
    name: 'reasoning',
    aliases: ['scratchpad'],
    /* Shows the scratchpad; `/think` decides whether one is produced.
       There is nothing to show with thinking off. */
    hint: 'Show or hide the scratchpad (needs `/think` on)',
    arg: 'on|off',
    run: (arg) => ({ kind: 'reasoning', show: bool(arg) })
  },
  {
    name: 'pin',
    aliases: ['autohide'],
    hint: 'Keep on top, or let it hide when you click away',
    arg: 'on|off',
    run: (arg) => ({ kind: 'pin', pinned: bool(arg) })
  },
  {
    name: 'model',
    aliases: ['models', 'gemini'],
    hint: 'Choose the model, or rank the list by `balanced`, `smarts` or `speed`',
    arg: 'name | order | check [runs]',
    // With a name it sets directly, which is quicker than the picker once you
    // know what you want and is the only way to reach a model not in the list.
    run: (arg) => {
      /*
       * `check` before the name lookup, and it cannot collide: it is matched
       * whole, and no catalogue id is one word. A model genuinely called
       * "check" would still be reachable from the picker.
       */
      const name = arg.trim()
      /*
       * An optional run count: `/model check 3`. Two by default, because
       * one run is a sample and this codebase's own standard for a
       * measurement is two - the same reason `Measured.runs` exists. One
       * is still there for a quick look, and it says in the report that
       * that is what it was.
       */
      const checking = /^(?:check|test|verify|status)(?:\s+(\d+))?$/i.exec(name)
      if (checking) {
        const runs = checking[1] ? Number(checking[1]) : undefined
        if (runs !== undefined && (runs < 1 || runs > MAX_RUNS)) {
          return {
            kind: 'error',
            message: `\`/model check\` takes 1 to ${MAX_RUNS} runs. Two is the default.`
          }
        }
        return { kind: 'models', runs }
      }
      /*
       * `/model smarts` opens the list already on that tab.
       *
       * Same reasoning as `check` above and the same reason it cannot
       * collide: these are single bare words, and every id in the
       * catalogue carries a slash or a colon. A model genuinely called
       * "speed" would still be reachable from the picker, and from
       * `/model <provider>/speed`.
       *
       * Worth a command at all because the tabs are a setting: somebody
       * who always wants the quickest thing says so once, and the answer
       * that tells them about it can offer the word as a button.
       */
      const ordering = readOrdering(name)
      if (ordering) return { kind: 'modelorder', ordering }
      return { kind: 'model', name }
    }
  },
  {
    name: 'open',
    aliases: ['browse', 'go', 'google'],
    hint: 'Open a page, or search the web, in your browser',
    arg: 'url or words',
    argRequired: true,
    run: (arg) =>
      arg.trim()
        ? { kind: 'open', what: arg.trim() }
        : {
            kind: 'error',
            message: 'Give me a link or something to search for: `/open wikipedia.org`'
          }
  },
  {
    name: 'engine',
    aliases: ['searchengine'],
    hint: 'Choose which search engine the browser opens',
    run: () => ({ kind: 'engine' })
  },
  {
    /*
     * What everything is set to, which the app could not say.
     *
     * Thirty-one commands change something and none of them showed what it
     * was currently set to. The palette lists what exists, /usage says what
     * has been spent, and the answer to "did you pick DuckDuckGo for me"
     * was a conversation with a model about its own app.
     */
    name: 'settings',
    aliases: ['config', 'prefs', 'preferences'],
    hint: 'What Wumpy is set to, and what changes each one',
    run: () => ({ kind: 'settings' })
  },
  {
    /*
     * Asked for in these words: "every hour he uses the other API key to
     * check the availability and rank all the models... but if the user
     * runs out of 40 requests per minute, then use the second API key for
     * the backup and pause the ranking."
     *
     * Bare it reports, because the first question about a thing that runs
     * by itself is whether it is running and what it is waiting for.
     */
    name: 'rank',
    aliases: ['ranking', 'autorank'],
    hint: 'Re-measure the models in the background, on the spare key',
    arg: 'on|off|now',
    run: (arg) => {
      const word = arg.trim().toLowerCase()
      if (!word) return { kind: 'rank', set: null, now: false }
      if (/^(on|yes|start)$/.test(word)) return { kind: 'rank', set: true, now: false }
      if (/^(off|no|stop)$/.test(word)) return { kind: 'rank', set: false, now: false }
      if (/^(now|check|sweep|go)$/.test(word)) return { kind: 'rank', set: null, now: true }
      return { kind: 'error', message: 'Usage: `/rank` to see it, `/rank on`, `/rank off`, `/rank now`.' }
    }
  },
  {
    name: 'usage',
    aliases: ['tokens', 'quota', 'spend'],
    hint: 'What today has cost, per model',
    arg: 'reset',
    run: (arg) => ({ kind: 'usage', reset: /^reset$|^clear$/i.test(arg.trim()) })
  },
  {
    /*
     * Asked for in these words: "add like a command like slash log, to
     * basically it has all the logs of what you've done. So then, you know,
     * for example, at like the time, for example, they re-rank all the
     * models, or for example, change model at this time."
     *
     * Both examples are things that happen with nobody watching, which is
     * why neither `/rank` nor `/settings` could answer them: those say what
     * is true NOW. This is the only question a timeline answers - what
     * changed while I was not looking, and when.
     */
    name: 'log',
    /* Not `history`: that is already an alias of `/chats`, and the saved
       conversations are a different thing from what the app has been doing. */
    aliases: ['logs', 'activity', 'timeline'],
    /* "and keeps up" is the thing worth knowing that the output does not
       say: the block fills in by itself while it is the last message, so
       an hourly sweep arrives while you are looking at it. Said here
       rather than in a footer line, which would cost a line of panel on
       every single `/log`. */
    hint: 'What Wumpy has done, and when — keeps up as it happens',
    arg: 'all | clear | model | ran',
    /* Offered as a button, but never with its argument: see clickBareOnly. */
    clickBareOnly: true,
    run: (arg) => {
      const word = arg.trim().toLowerCase()
      if (!word) return { kind: 'journal', all: false, clear: false, only: null }
      if (/^(all|everything|full|more)$/.test(word)) {
        return { kind: 'journal', all: true, clear: false, only: null }
      }
      if (/^(clear|forget|wipe|reset|delete)$/.test(word)) {
        return { kind: 'journal', all: false, clear: true, only: null }
      }
      /* A kind, in whichever word came to mind: `/log model`, `/log ran`,
         `/log commands` all work. Filtered views are never truncated -
         the filter has already done the narrowing. */
      const only = readKind(word)
      if (only) return { kind: 'journal', all: true, clear: false, only }
      return {
        kind: 'error',
        message:
          'Usage: `/log` for the recent ones, `/log all` for the whole day, ' +
          '`/log model` or `/log ran` for one sort, `/log clear` to forget it.'
      }
    }
  },
  {
    name: 'remember',
    aliases: ['context', 'notes'],
    hint: 'Notes Wumpy carries from one chat to the next',
    arg: '<thing to remember> | clear',
    /**
     * The one thing that survives a new chat.
     *
     * Every conversation starts from nothing, which is why the prompt has
     * to forbid promising to remember anything. This is the exception, and
     * it is a plain file the user can open rather than a store they have
     * to take on trust.
     */
    run: (arg: string): CommandAction => {
      const rest = (arg ?? '').trim()
      if (/^(clear|forget|reset|none)$/i.test(rest)) {
        return { kind: 'remember', value: '', clear: true }
      }
      return { kind: 'remember', value: rest, clear: false }
    }
  },
  {
    name: 'key',
    aliases: ['apikey'],
    hint: 'Add or remove hosted-model API keys (several rotate)',
    arg: 'google|groq|mistral|nvidia [add|check|drop|clear|accounts] <key…>',
    argRequired: true,
    /**
     * Parsed here rather than in a dialog because a key is pasted, and the
     * composer is where pasting happens. The value is handed straight to the
     * main process and never stored in the renderer - not in state, not in the
     * input history, which `/key` is excluded from for that reason.
     */
    run: (arg) => {
      const parts = arg.trim().split(/\s+/).filter(Boolean)
      const provider = parts[0]?.toLowerCase()
      if (!isProviderId(provider)) {
        return {
          kind: 'error',
          message:
            'Say which one: ' +
            PROVIDER_IDS.map((id) => `\`/key ${id} <key>\``).join(', ') +
            '. Add `clear` to one of those to remove it.'
        }
      }
      /*
       * Ollama is in PROVIDER_IDS so it routes and so the picker can offer
       * it, but it has no key: the daemon is on localhost and a cloud model
       * there is authorised by whoever ran `ollama signin`. Without this the
       * command would cheerfully encrypt a key that is never read.
       */
      if (PROVIDERS[provider].keyless) {
        return {
          kind: 'error',
          message:
            `${PROVIDERS[provider].label} needs no key here — it runs on your own machine. ` +
            'Sign in with `ollama signin` if a cloud model asks you to.'
        }
      }
      let rest = parts.slice(1).join(' ')
      if (!rest) return { kind: 'key', provider, value: '', clear: false, add: false }
      if (/^(clear|remove|forget|off)$/i.test(rest)) {
        return { kind: 'key', provider, value: '', clear: true, add: false }
      }
      /*
       * `check` asks the provider whether each key still authenticates, with
       * a models listing that costs nothing from the day's allowance. Worth
       * a word of its own because a dead key is invisible otherwise: three
       * of the twenty on this machine had been refused for weeks.
       */
      if (/^(check|test|verify)$/i.test(rest)) {
        return { kind: 'key', provider, value: '', clear: false, add: false, check: true }
      }
      /*
       * `accounts separate` tells Wumpy something it cannot find out.
       *
       * A rate limit belongs to the account on every provider but Google,
       * and two keys look identical whether they came from one login or
       * two. Said wrong in the cautious direction the app simply paces
       * slower than it could; said right it uses what the user actually
       * paid in sign-ups for. With no argument it reports what it thinks.
       */
      const accounts = /^accounts?(?:\s+(.*))?$/i.exec(rest)
      if (accounts) {
        const word = (accounts[1] ?? '').trim().toLowerCase()
        if (!word) return { kind: 'accounts', provider, mode: null }
        if (/^(separate|different|several|many|own)$/.test(word)) {
          return { kind: 'accounts', provider, mode: 'separate' }
        }
        if (/^(shared|same|one|single)$/.test(word)) {
          return { kind: 'accounts', provider, mode: 'shared' }
        }
        return {
          kind: 'error',
          message:
            `\`/key ${provider} accounts separate\` if each key is from its own ` +
            `account, \`shared\` if they are all from one. ` +
            `\`/key ${provider} accounts\` says which it currently assumes.`
        }
      }
      /*
       * `drop 1 2 3` removes by position, which is what `check` reports.
       * Parsed here so the numbers are numbers before they cross: the
       * handler on the other side has no way to ask what was meant.
       */
      const dropping = /^(drop|remove|delete)\s+(.+)$/i.exec(rest)
      if (dropping) {
        const numbers = dropping[2]
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number)
        if (!numbers.length || numbers.some((n) => !Number.isInteger(n) || n < 1)) {
          return {
            kind: 'error',
            message:
              `Which ones? \`/key ${provider} drop 1 2 3\` — ` +
              `the numbers \`/key ${provider} check\` gave.`
          }
        }
        return { kind: 'key', provider, value: '', clear: false, add: false, drop: numbers }
      }
      /**
       * `add` keeps what is already stored, which matters once there is
       * more than one. Gemini's free tier is five requests a minute PER
       * PROJECT, so several keys is the normal case rather than the odd
       * one, and replacing four of them by pasting the fifth is a trap.
       */
      const adding = /^(add|more|another)\s/i.test(rest)
      if (adding) rest = rest.replace(/^\S+\s+/, '')
      return { kind: 'key', provider, value: rest, clear: false, add: adding }
    }
  },
  {
    /*
     * Self-reflection. The worker keeps going; when it is done a mentor - on
     * the other key - reviews it, and REVISE sends it back for another pass.
     * Toggled, because most questions do not need a second opinion and every
     * review is a request against the same allowance.
     */
    name: 'reflect',
    aliases: ['mentor', 'reflection', 'selfreflect'],
    hint: 'Self-reflection: a mentor reviews finished work until it passes',
    arg: 'on|off|<rounds>|model <id>',
    /* A button only bare: the rounds and the mentor model decide how many
       requests each task costs, and that is typed, not clicked in an answer. */
    clickBareOnly: true,
    run: (arg) => {
      const a = arg.trim()
      const model = /^model\s+(\S+)$/i.exec(a)
      if (model) return { kind: 'reflect', on: true, model: model[1] }
      if (/^model$/i.test(a)) return { kind: 'reflect', on: true, model: '' }
      if (/^[1-9]\d*$/.test(a)) return { kind: 'reflect', on: true, rounds: Number(a) }
      return { kind: 'reflect', on: bool(a) }
    }
  },
  {
    name: 'voice',
    aliases: ['dictate', 'dictation', 'mic'],
    hint: 'Talk instead of typing — hold the spacebar',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'on', on: bool(arg) })
  },
  {
    /*
     * "the local model" until 18 Oct, which stopped being true the day
     * Wumpy went cloud-only and was a worse kind of stale than most: it
     * named the one property anyone would weigh this setting on. Polishing
     * used to be a guarantee that dictation never left the machine. It now
     * sends what was dictated to the model provider, which is a different
     * bargain - the defaults say so, and this was still advertising the
     * old one.
     */
    name: 'polish',
    aliases: ['autocorrect'],
    hint: 'Tidy dictated punctuation — sends it to the model',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'polish', on: bool(arg) })
  },
  {
    /*
     * The instructions are the largest fixed cost of every turn, and most of
     * what made them large was remediation for a weak local model. This sends
     * the short form: 4,553 tokens instead of 7,059, with the thirteen rules
     * that were measured to carry the benchmark kept intact.
     */
    /*
     * Whether the model reasons before answering.
     *
     * The plumbing was always there and wired to a constant: `thinking`
     * reaches reasoning_effort, the chat template switch and the token
     * ceiling, each doing something different with it. What was missing
     * was a way to say so.
     *
     * Two names rather than an argument, because the whole point is to
     * flip it mid-conversation without thinking about syntax - `/think`
     * before a hard question, `/nothink` when it is just chat.
     */
    name: 'think',
    /*
     * NOT aliased to `reason`, which `/reasoning` already owns and which
     * means something else: that one shows or hides the scratchpad, this
     * one decides whether there is a scratchpad at all. Two commands a
     * letter apart doing different things is how someone turns off the
     * wrong one and cannot work out why nothing changed.
     */
    aliases: ['thinking'],
    hint: 'Reason before answering — better answers, slower first word',
    arg: 'on|off',
    run: (arg) => ({ kind: 'setting', setting: 'thinking', on: arg.trim() ? bool(arg) : true })
  },
  {
    name: 'nothink',
    aliases: ['fast', 'quick'],
    hint: 'Answer straight away — for chat and quick questions',
    run: () => ({ kind: 'setting', setting: 'thinking', on: false })
  },
  {
    name: 'lean',
    aliases: ['short', 'brief'],
    hint: 'Send the short instructions: ~2,500 fewer tokens every turn',
    arg: 'on|off',
    run: (arg) => ({ kind: 'setting', setting: 'leanPrompt', on: bool(arg) })
  },
  {
    name: 'autostop',
    aliases: ['pushtotalk'],
    hint: 'Stop dictating by itself when you stop talking',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'autostop', on: bool(arg) })
  },
  {
    /*
     * "When I'm using Wumpy, turn off the background music too." On by
     * default - it is what was asked for - and a command to say otherwise
     * for somebody who wants their music under everything.
     */
    name: 'music',
    aliases: ['pausemusic'],
    hint: 'Pause music while Wumpy listens and talks',
    arg: 'on|off',
    run: (arg) => ({ kind: 'voice', setting: 'music', on: bool(arg) })
  },
  /*
   * THERE IS NO `/listen`, AND THAT IS THE POINT.
   *
   * Asked for in these words, with a screenshot of the thing working as it
   * should: "remove the command, i like it when i ask it directly."
   *
   * It had already been cut down twice. It took an argument for a day -
   * `/listen notes`, `/listen stop`, and worst of all `/listen what did they
   * say about the deadline`, which was reported exactly as it deserved:
   * "that's too long. How am I supposed to remember this?" The argument went,
   * and then the word itself, because a word somebody has to have met before
   * is still a thing to remember.
   *
   * The action it built has not gone anywhere - see CommandAction's 'listen'.
   * What builds it now is intents.ts, from the sentence a person would say
   * without being taught: "listen to this meeting", "listen and summarise
   * content in this meeting", "stop listening". While a session is running
   * every ordinary message already carries the transcript, so asking about
   * the meeting is just asking, and the status bar has the one button there
   * is. Nothing here needs a name any more.
   */
  {
    name: 'approve',
    aliases: ['auto', 'permissions'],
    hint: 'manual | auto | all — how much runs without asking',
    arg: 'mode',
    run: (arg) => {
      const a = arg.trim().toLowerCase()
      if (!a) return { kind: 'approve', mode: 'cycle' }
      if (['manual', 'ask', 'off'].includes(a)) return { kind: 'approve', mode: 'manual' }
      if (['auto', 'safe', 'read'].includes(a)) return { kind: 'approve', mode: 'auto' }
      if (['all', 'everything', 'yolo'].includes(a)) return { kind: 'approve', mode: 'all' }
      return { kind: 'error', message: 'Usage: /approve manual | auto | all' }
    }
  },
  {
    name: 'compact',
    aliases: ['summarise', 'summarize'],
    hint: 'Summarise older turns to free up context',
    run: () => ({ kind: 'compact' })
  },
  {
    name: 'also',
    hint: 'Add something while an answer is still running',
    arg: 'text',
    // Only meaningful mid-answer, and the app intercepts it there. Reaching
    // here means nothing was running, so it is just a message.
    run: (arg) =>
      arg.trim()
        ? { kind: 'prompt', text: arg.trim(), label: 'also' }
        : { kind: 'info', message: '`/also <text>` adds a note while an answer is still running.' }
  },
  { name: 'stop', hint: 'Stop generating', run: () => ({ kind: 'stop' }) },
  { name: 'help', aliases: ['?'], hint: 'List every command', run: () => ({ kind: 'help' }) },
  /* Named for the word the request used - "see all of the shortcuts" - with
     /hotkeys too, since that is what this app calls the key that summons the
     panel. Not /keys, and not even as an alias: see the action above. */
  {
    name: 'shortcuts',
    aliases: ['hotkeys'],
    hint: 'Every keyboard shortcut',
    run: () => ({ kind: 'shortcuts' })
  },
  { name: 'quit', aliases: ['exit'], hint: 'Quit Wumpy', run: () => ({ kind: 'quit' }) },

  ...PROMPT_COMMANDS.map((p): CommandSpec => ({
    name: p.name,
    hint: p.hint,
    arg: 'text',
    // All six wrap something the user has to write. Bare they have nothing
    // to wrap, so Enter completes them and waits, rather than running them
    // into their own usage line.
    argRequired: true,
    run: (arg) =>
      arg.trim()
        ? { kind: 'prompt', text: p.wrap(arg.trim()), label: p.label }
        : { kind: 'error', message: `Usage: /${p.name} <text>` }
  }))
])

/**
 * Every key, in one place.
 *
 * There were three lists: a hand-written markdown table inside /help, a
 * KEY_ONLY array for the Ctrl+K palette, and a SHORTCUT_FOR map putting the
 * key beside its command. The same chord was therefore written out two or
 * three times, in different words and different arrow glyphs - "Alt+Up /
 * Alt+Down | Step through the conversation a message at a time" in one and
 * "Alt+↑ / Alt+↓ | Step through messages" in the other - and nothing made
 * them agree. /shortcuts exists to answer "what are the shortcuts", and it can
 * only answer it honestly if there is one list to read.
 *
 * `runs` names the command the key is a shortcut for, where there is one.
 * That is what puts the chord beside it in the palette, and what keeps the
 * key from being listed twice there - once on its command's row and once on
 * its own.
 *
 * Grouped the way they are used rather than alphabetically: typing, then the
 * panel, then proposals, then reading back, then the way out.
 */
export const KEYS: readonly {
  readonly keys: string
  readonly what: string
  readonly runs?: readonly string[]
}[] = [
  { keys: 'Enter / Shift+Enter', what: 'Send, or start a new line' },
  { keys: '↑ / ↓', what: 'Recall what you typed before, in an empty box' },
  { keys: 'Ctrl+M', what: 'Start or stop dictation' },
  { keys: 'Ctrl+K', what: 'Every command, searchable' },
  /*
   * Ctrl+/ rather than F1.
   *
   * "don't use my f1 or f2 those are essential" - they belong to something
   * else on this machine, and a panel that floats over whatever you were
   * working in has no business taking a key you need there. Ctrl+/ is what
   * most apps use for "show me the shortcuts" anyway, and / is already the
   * key that starts a command here.
   *
   * Ctrl+Shift+/ - which is Ctrl+? - does the same, both because that is the
   * other way people type it and because / is a shifted key on some
   * layouts.
   */
  { keys: 'Ctrl+/', what: 'Every keyboard shortcut', runs: ['shortcuts'] },

  /*
   * Ctrl+Tab rather than F6, which is what this was.
   *
   * F6 is the Windows convention and nobody remembers it: "don't make it too
   * hard to remember - like function 16, like what the hell, function 6,
   * like what the hell". Ctrl+Tab is the same idea with nothing to memorise,
   * because Tab already means "the next thing" and Ctrl is already how this
   * app says "the bigger version of that". F6 still works and is listed
   * beside it, since it costs nothing and is what a Windows user may try.
   */
  {
    keys: 'Ctrl+Tab / Ctrl+Shift+Tab',
    what: 'Move between the header, transcript, status bar and box (also F6)'
  },
  { keys: 'Ctrl+N', what: 'New chat', runs: ['new'] },
  { keys: 'Ctrl+R', what: 'Reopen a saved chat', runs: ['resume'] },
  { keys: 'Ctrl+Shift+M', what: 'Change the model', runs: ['model'] },
  { keys: 'Ctrl+D', what: 'Move the panel to the next corner', runs: ['dock'] },
  { keys: 'Ctrl+P', what: 'Pin or unpin', runs: ['pin'] },
  {
    keys: 'Shift+Tab',
    what: 'Cycle approval mode (from the box; elsewhere it steps back)',
    runs: ['approve']
  },

  { keys: 'Ctrl+Enter', what: 'Run the newest proposal' },
  { keys: 'Ctrl+Shift+Enter', what: 'Skip the newest proposal' },
  { keys: 'Ctrl+↓ / Ctrl+↑', what: 'Step into the newest / first proposal' },
  { keys: '← / →', what: 'Move between a proposal’s buttons' },
  { keys: 'Space', what: 'Press the button that has focus' },

  { keys: 'Alt+↑ / Alt+↓', what: 'Step through the conversation a message at a time' },
  { keys: 'PageUp / PageDown', what: 'Move through the transcript, or a list, a page at a time' },
  { keys: 'Ctrl+Home / Ctrl+End', what: 'Jump to the ends of the transcript, or of a list' },
  { keys: 'Tab', what: 'Switch tabs in a list' },
  { keys: 'Ctrl+Shift+C', what: 'Copy the last answer' },

  { keys: 'Ctrl+C', what: 'Stop the answer (copies instead if text is selected)' },
  {
    keys: 'Esc',
    what: APP_WINDOW ? 'Stop the answer, or back to the box' : 'Back to the box, then close the panel'
  }
].filter((k) => !(APP_WINDOW && k.runs?.some((r) => PANEL_ONLY_COMMANDS.has(r))))

/**
 * Keys that reach a command directly, shown beside it in the menu.
 *
 * The menu is for finding things. Showing the key is what stops it being
 * needed a second time. Derived from KEYS, so a chord cannot be advertised
 * on a command's row in one wording and in the key table in another.
 */
export const SHORTCUT_FOR: Record<string, string | undefined> = {
  /* Not a key at all: the thing worth knowing about /also is WHEN it is for,
     and the palette's hint column is where there is room to say it. */
  also: 'while busy',
  /* Esc is layered - it stops an answer, else steps out of a card, else
     hides the panel - so the table lists it once, with no command, and both
     commands it stands in for are named here. */
  stop: 'Esc',
  quit: 'Esc',
  ...Object.fromEntries(
    KEYS.flatMap((k) => (k.runs ?? []).map((command) => [command, k.keys] as const))
  )
}

/**
 * Keys that are not a command, listed so Ctrl+K can show them anyway.
 *
 * The palette was built from the command list, so anything with no slash
 * command behind it — approving a proposal, stepping through the transcript,
 * copying the last answer — was undiscoverable unless you already knew it.
 * That is most of the navigation.
 */
export const KEY_ONLY: Array<{ keys: string; what: string }> = KEYS.filter((k) => !k.runs).map(
  (k) => ({ keys: k.keys, what: k.what })
)

/** Every command, for the menu. */
export function allCommands(): CommandSpec[] {
  return COMMANDS
}

/** Every name and alias, for matching. */
function matches(spec: CommandSpec, name: string): boolean {
  return spec.name === name || (spec.aliases?.includes(name) ?? false)
}

export function findCommand(name: string): CommandSpec | undefined {
  const n = name.toLowerCase()
  return COMMANDS.find((c) => matches(c, n))
}

/**
 * Commands whose name starts with the typed prefix, for the palette.
 * An empty prefix lists everything.
 */
export function completions(input: string): CommandSpec[] {
  if (!input.startsWith('/')) return []
  const [name] = input.slice(1).split(/\s+/)
  const n = name.toLowerCase()
  if (!n) return COMMANDS
  return COMMANDS.filter(
    (c) => c.name.startsWith(n) || (c.aliases?.some((a) => a.startsWith(n)) ?? false)
  )
}

/**
 * Parses a composer line. Returns null when the text is an ordinary message,
 * so the caller can send it unchanged.
 */
export function parseCommand(input: string): CommandAction | null {
  const text = input.trim()
  if (!text.startsWith('/')) return null

  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
  if (!match) return null

  const [, name, arg] = match
  const spec = findCommand(name)
  if (!spec) {
    /*
     * The one the user was trying to type, when there is one.
     *
     * "Unknown command /mdoel. Type /help to see them all." is true and
     * sends you to a table of twenty-seven to find the command you were
     * already typing. It is nearly always one keystroke away and this file
     * is holding the list. Nothing is offered when nothing is close - see
     * @shared/nearest for why a wrong guess is worse than none.
     */
    /* The SPELLING that matched, not the canonical name: someone who typed
       "/qouta" meant "/quota", which is a real alias of /usage and works -
       answering "/usage" sends them to a word they did not reach for. */
    const did = nearest(name, COMMANDS)
    /* As code, because the renderer offers a clickable command as a button
       and this is the moment it is most wanted: the user has the command
       nearly right and would otherwise retype the whole line. */
    const hint = did ? ` Did you mean \`/${did.via}\`?` : ''
    return {
      kind: 'error',
      message: `Unknown command /${name}.${hint} Type /help to see them all.`
    }
  }
  return spec.run(arg ?? '')
}

/** Markdown table of every command, rendered by /help. */
export function helpText(): string {
  /*
   * Each name as code, so the clickable ones arrive as buttons.
   *
   * /help is where somebody goes to find out what exists, which makes it the
   * worst place to end at "now type it out". The renderer turns inline code
   * that is nothing but a command into a button - see readCommandChip - so
   * the table is a menu for the nineteen commands that may be offered, and
   * stays a table for /key, /delete and the rest.
   */
  /*
   * A PIPE IN AN ARGUMENT IS A COLUMN SEPARATOR, backticks or not.
   *
   * Twelve of these rows take `on|off`, and GFM splits a table row on its
   * pipes BEFORE it parses anything inline - so `<on|off>` made a four-cell
   * row in a two-column table, and a renderer drops the cells past the
   * header. The description was silently gone from a third of /help, and
   * /key's row read `google` and nothing else. Invisible in the source,
   * invisible in the markdown, visible only in the panel.
   *
   * `\|` is the escape GFM defines for exactly this, and it survives inside
   * a code span: the cell renders with a real pipe in it.
   *
   * The HINTS need it too, and that is what found the last two: `/dock` says
   * "left | right | top-right" and `/approve` says "manual | auto | all",
   * both of them cut off mid-sentence in the panel. The strings are left
   * alone - the Ctrl+K palette shows them as plain text, where a pipe is
   * just a pipe - and escaped here, where a pipe is punctuation.
   */
  const bar = (text: string): string => text.replace(/\|/g, '\\|')
  const rows = COMMANDS.map((c) => {
    const names = [c.name, ...(c.aliases ?? [])].map((n) => `\`/${n}\``).join(', ')
    const arg = c.arg ? ` \`<${bar(c.arg)}>\`` : ''
    return `| ${names}${arg} | ${bar(c.hint)} |`
  })
  return [
    '**Commands**',
    '',
    '| Command | What it does |',
    '| --- | --- |',
    ...rows,
    '',
    /* The same rows /shortcuts prints, from the same list. They were typed out
       again here, in different words, and drifted. */
    ...keyRows(),
    '',
    ...markRows(),
    '',
    'Typing while an answer is running queues the message until it finishes.',
    'Start it with `/also` instead and it is added as a note straight away,',
    'without interrupting: the answer carries on and the model sees it next turn.'
  ].join('\n')
}

/** The keys as a markdown table, for /shortcuts and for the end of /help. */
function keyRows(): string[] {
  return [
    '**Keys**',
    '',
    '| Key | What it does |',
    '| --- | --- |',
    ...KEYS.map((k) => `| ${k.keys} | ${k.what} |`)
  ]
}

/*
 * The four marks, because a shape nobody can look up is a shape to be
 * guessed at.
 *
 * Built from kinds.ts rather than typed out here: the table is the only
 * place the system is explained, and an explanation that can drift from
 * what is drawn on screen is worse than none.
 */
function markRows(): string[] {
  return [
    '**What a card would touch**',
    '',
    'The shape at the top-left of a card says what it would do, in its own',
    'colour. Red overrides the colour and keeps the shape: that one is',
    'destructive.',
    '',
    '| Mark | Meaning |',
    '| --- | --- |',
    ...markLines().map((m) => `| ${m.glyph} | ${m.what} |`)
  ]
}

/**
 * Every shortcut, and nothing else: `/shortcuts`.
 *
 * They were a table inside /help, below sixty rows of commands - a long
 * scroll to reach the one table nobody memorises, in the one place you go
 * when you cannot remember something. Asked for by name.
 *
 * The card marks come too. They are not keys, but they are the other thing
 * on screen that is a symbol rather than a word, and this is now the place
 * you come to have a symbol explained.
 */
export function shortcutsText(): string {
  return [
    ...keyRows(),
    '',
    ...markRows(),
    '',
    'Every command is in `/help`, or press Ctrl+K to search them.'
  ].join('\n')
}

/* ------------------------------------------------ commands you can click */

/**
 * The commands an answer may offer as a button.
 *
 * Wumpy is told to answer "rename this chat" with `/rename` and nothing else,
 * which is the right answer and a dead end: the user reads a command and then
 * has to type it. The same happens with every "did you mean" and every usage
 * line. This list is what turns that text into one click.
 *
 * It is an allowlist, and the exclusions are the point. Answers are model
 * output, and this app feeds the model web pages - so a page can propose the
 * words in an answer, and a button is easier to click than a command is to
 * type. Nothing here reaches past the app:
 *
 *   /key       takes a secret. A planted `/key nvidia <theirs>` would replace
 *              the user's own key with somebody else's, in one click.
 *   /approve   sets how much runs without being asked. One click to "run
 *              everything" is the whole permission model.
 *   /delete    destroys the chat, /quit closes the app. Both unaskable-for.
 *   /open      opens a page in the real browser. There is already a card for
 *              that, and it names the host and says why it refused.
 *   /screen    sends a photograph of their screen to the model.
 *   /remember  writes to what persists between chats, from the argument.
 *   the prompt wrappers (/plan, /btw, ...) wrap text that is not there yet.
 *
 * What is left changes the app and nothing else, and every one of them is
 * reversible by doing it again.
 */
export const CLICKABLE: readonly string[] = [
  'new',
  'resume',
  'chats',
  'compact',
  'rename',
  'model',
  'dock',
  'engine',
  'settings',
  'rank',
  'usage',
  /* Bare only - the argument is where `clear` lives. See clickBareOnly. */
  'log',
  'pin',
  'reasoning',
  'voice',
  'polish',
  'autostop',
  'music',
  'reflect',
  'think',
  'nothink',
  'lean',
  'help',
  'shortcuts'
]

/**
 * The command in a line of an answer, if it is one that may be clicked.
 *
 * Deliberately strict about shape: only text that is nothing but a command
 * becomes a button, so a sentence mentioning `/model` in passing stays a
 * sentence. Aliases resolve, so `/tokens` offers the button `/usage` would.
 *
 * The argument is where the care goes, because "/engine changes which one
 * opens" is a line of prose that starts with a command - and it was a button
 * until this check caught it. Three rules, each from that one example:
 *
 *   the command must TAKE an argument. /engine does not, so anything after
 *   it is prose, and a button labelled with a sentence is nobody's idea of a
 *   command.
 *
 *   it must be short - three words, thirty-two characters. Values are short:
 *   `gemma4:31b-cloud`, `bottom-right`, `Fish pie`. Explanations are not.
 *
 *   and it must not end like a sentence. A title does not end in a full stop
 *   and a model name never has.
 *
 * A long title is missed by this, and stays text, which is where it was.
 */
export function readCommandChip(text: string): string | null {
  const line = text.trim()
  if (!line.startsWith('/') || line.length > 72 || line.includes('\n')) return null

  const match = /^\/(\S+)(?:\s+(.*))?$/.exec(line)
  if (!match) return null

  const spec = findCommand(match[1])
  if (!spec || !CLICKABLE.includes(spec.name)) return null

  const arg = (match[2] ?? '').trim()
  if (!arg) {
    /* `/rename` bare answers with its own usage line, which is a worse
       button than no button. */
    return spec.argRequired ? null : line
  }
  if (!spec.arg || spec.clickBareOnly) return null
  if (arg.length > 32 || arg.split(/\s+/).length > 3) return null
  if (/[.!?,;:]$/.test(arg)) return null
  return line
}

/* ------------------------------------------------ commands the model runs */

/**
 * Commands the model may never propose, however it asks.
 *
 *   /key       takes a secret: a planted `/key nvidia <theirs>` swaps the
 *              user's key for somebody else's.
 *   /approve   decides what runs without being asked - the permission model
 *              itself, which nothing the model says may change.
 *   /open      has its own card (wumpy-open), which names the host and
 *              refuses what it should.
 *
 * Everything else changes Wumpy and nothing outside it, and still waits for
 * a yes. Asked for in these words: "I can ask the AI to run... an actual
 * command in the chat... delete this chat. And then it's going to tell me,
 * are you sure you want to delete this chat? And then I'm going to say yes."
 */
const NEVER_PROPOSED = new Set(['key', 'approve', 'open'])

export interface AppProposal {
  /** The command line, as typed: `/rename Fish pie`. */
  line: string
  /** The `# why` line, or what the command does when there is none. */
  reason: string
  /** Why it will not run, when it will not. */
  refused: string | null
  /**
   * May run without asking on accept-all: the same rule as a clickable
   * command in an answer, which only lets through the ones that change the
   * app and nothing else and can be undone by doing it again.
   */
  harmless: boolean
}

/** Reads a ```wumpy-app block: a `# why` line and one command. */
export function readAppProposal(body: string): AppProposal | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim())
  const line = lines.find((l) => l.startsWith('/'))
  if (!line) return null
  const why = lines
    .filter((l) => l.startsWith('#'))
    .map((l) => l.replace(/^#+\s*/, ''))
    .join(' ')
    .trim()
  const name = /^\/(\S+)/.exec(line)?.[1] ?? ''
  const spec = findCommand(name)
  const reason = why || spec?.hint || line
  if (!spec) return { line, reason, refused: `Wumpy has no /${name} command.`, harmless: false }
  if (NEVER_PROPOSED.has(spec.name)) {
    return {
      line,
      reason,
      refused: `/${spec.name} is yours to type. Wumpy never runs it for the model.`,
      harmless: false
    }
  }
  const action = parseCommand(line)
  if (!action || action.kind === 'error' || action.kind === 'prompt' || action.kind === 'accounts') {
    return {
      line,
      reason,
      refused: action?.kind === 'error' ? action.message : `${line} is not something the model can run.`,
      harmless: false
    }
  }
  return { line, reason, refused: null, harmless: readCommandChip(line) !== null }
}
