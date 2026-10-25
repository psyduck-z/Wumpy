import type { Dock, ProviderName } from '@shared/types'
import { PROVIDER_IDS, PROVIDERS, isProviderId } from '@shared/cloud'
import { MAX_RUNS } from '@shared/probe'
import { readOrdering, type Ordering } from '@shared/order'
import { readKind, type EventKind } from '@shared/journal'
import { nearest } from '@shared/nearest'

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
  /** No argument deletes the chat you are in; `/delete pick` opens the list. */
  | { kind: 'delete'; pick: boolean }
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
  | { kind: 'voice'; setting: 'on' | 'polish' | 'autostop'; on: boolean | 'toggle' }
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

export const COMMANDS: CommandSpec[] = [
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
          'Usage: `/log` for the recent ones, `/log all` for everything kept, ' +
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
     * Listening to the machine, for meetings.
     *
     * ONE WORD, and that is the whole design now. It took an argument for
     * a day - `/listen notes`, `/listen stop`, and worst of all `/listen
     * what did they say about the deadline`, which was reported exactly
     * as it deserved: "that's too long. How am I supposed to remember
     * this?"
     *
     * Nobody should have to. `/listen` starts it and `/listen` stops it,
     * and while it is listening every ordinary message already carries
     * the transcript - so asking about the meeting is asking, and the
     * notes are "notes". See @shared/meeting.meetingTurn and the intents
     * table, which catches "stop listening" said in English too.
     *
     * The old words still work, because somebody may have learned them
     * in the day they existed, but nothing teaches them any more: `arg`
     * is gone, so the palette no longer waits for one and Enter runs it.
     *
     * NOT aliased to `record`, which is what it is not: nothing is kept
     * but text, and a name that promises a recording would be a promise
     * this does not make.
     */
    name: 'listen',
    /* NOT `notes`, which `/remember` has owned since before this existed -
       and which would be the wrong half anyway: the notes are what comes
       out, the listening is the thing being switched on. */
    aliases: ['meeting', 'call'],
    hint: 'Hear your speakers and take notes — say it again to stop',
    run: (arg) => {
      const word = arg.trim().toLowerCase()
      if (!word) return { kind: 'listen', what: 'toggle', ask: '' }
      if (['stop', 'off', 'end', 'done'].includes(word)) return { kind: 'listen', what: 'stop', ask: '' }
      if (['notes', 'summary', 'summarise', 'summarize'].includes(word))
        return { kind: 'listen', what: 'notes', ask: '' }
      if (['mic', 'me', 'both', 'system', 'them', 'speakers'].includes(word))
        return { kind: 'listen', what: 'source', ask: word }
      /* Anything else said after the word is an ordinary message that
         happens to begin with it, and ordinary messages already carry the
         transcript. Nothing to parse. */
      return { kind: 'listen', what: 'toggle', ask: '' }
    }
  },
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
]

/**
 * Keys that reach a command directly, shown beside it in the menu.
 *
 * The menu is for finding things. Showing the key is what stops it being
 * needed a second time.
 */
export const SHORTCUT_FOR: Record<string, string | undefined> = {
  also: 'while busy',
  new: 'Ctrl+N',
  resume: 'Ctrl+R',
  model: 'Ctrl+Shift+M',
  dock: 'Ctrl+D',
  pin: 'Ctrl+P',
  approve: 'Shift+Tab',
  stop: 'Esc',
  quit: 'Esc',
  help: 'Ctrl+K'
}

/**
 * Keys that are not a command, listed so Ctrl+K can show them anyway.
 *
 * The palette was built from the command list, so anything with no slash
 * command behind it — approving a proposal, stepping through the transcript,
 * copying the last answer — was undiscoverable unless you already knew it.
 * That is most of the navigation.
 */
export const KEY_ONLY: Array<{ keys: string; what: string }> = [
  { keys: 'Ctrl+Enter', what: 'Run the newest proposal' },
  { keys: 'Ctrl+Shift+Enter', what: 'Skip the newest proposal' },
  { keys: 'Ctrl+↓ / Ctrl+↑', what: 'Step into the newest / first proposal' },
  { keys: '← →', what: 'Move between a proposal’s buttons' },
  { keys: 'Alt+↑ / Alt+↓', what: 'Step through messages' },
  { keys: 'PgUp / PgDn', what: 'Scroll the transcript' },
  { keys: 'Ctrl+Home / Ctrl+End', what: 'Jump to the top / bottom' },
  { keys: 'Ctrl+Shift+C', what: 'Copy the last answer' },
  { keys: 'Ctrl+C', what: 'Stop generating (with nothing selected)' },
  { keys: 'Esc', what: 'Back to the box, then close the panel' },
  { keys: '↑ ↓', what: 'Recall what you typed before, in an empty box' }
]

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
    '**Keys**',
    '',
    '| Key | What it does |',
    '| --- | --- |',
    '| Ctrl+K | Every command, searchable |',
    '| ↑ / ↓ | Step back through what you have typed before |',
    '| Enter / Shift+Enter | Send / start a new line |',
    '| Ctrl+M | Start or stop dictation |',
    '| Ctrl+Shift+M | Change the model |',
    '| Ctrl+N | New chat |',
    '| Ctrl+R | Reopen a saved chat |',
    '| Ctrl+D | Move the panel to the next corner |',
    '| Ctrl+P | Pin or unpin |',
    '| Ctrl+Shift+C | Copy the last answer |',
    '| Ctrl+Enter | Run the command being asked about |',
    '| Ctrl+Shift+Enter | Skip it |',
    '| Ctrl+Down / Ctrl+Up | Step into the newest / first proposal |',
    '| ← / → | Move between a proposal’s buttons |',
    '| Ctrl+C | Stop the answer (copies instead if text is selected) |',
    '| Alt+Up / Alt+Down | Step through the conversation a message at a time |',
    '| Shift+Tab | Cycle approval mode |',
    '| PageUp / PageDown | Move through the transcript |',
    '| Ctrl+Home / Ctrl+End | Jump to the start, or to the latest |',
    '| Esc | Stop, go back, or hide |',
    '',
    'Typing while an answer is running queues the message until it finishes.',
    'Start it with `/also` instead and it is added as a note straight away,',
    'without interrupting: the answer carries on and the model sees it next turn.'
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
  'listen',
  'voice',
  'polish',
  'autostop',
  'think',
  'nothink',
  'lean',
  'help'
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
