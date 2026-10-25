import type { CommandAction } from './commands'

/**
 * Recognises plain-English requests for things Wumpy does itself.
 *
 * Asking a model to rename a chat is the worst possible use of it: the answer
 * is always the same slash command, and a reasoning model ties itself in knots
 * over being asked to do something it cannot. Measured on qwen3:4b, "rename
 * this chat to Speculative Fiction" took 129 seconds, produced 3,620 characters
 * of scratchpad and then no answer at all. The non-reasoning tiers get it right
 * but still take about six seconds to say a sentence the app already knows.
 *
 * So these never reach a model. Anything that does not match falls straight
 * through, exactly as before — this only ever short-circuits a phrasing that is
 * unambiguous.
 */
interface Intent {
  pattern: RegExp
  /** Builds the action from the match, or returns null to decline. */
  build(m: RegExpMatchArray): CommandAction | null
}

// Character classes as strings, so they can be composed into regexes below.
const QUOTE_OPEN = '["\'‘“]'
const QUOTE_CLOSE = '["\'’”]'

/** Trailing sentence punctuation, which is never part of a name. */
function trimTail(raw: string): string {
  return raw
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
}

/**
 * Works out what the user meant by any quotation marks in a title.
 *
 * There is no safe default. `rename this chat to "mathematics"` probably means
 * the quotes are punctuation, but `rename this chat to "very funny"` probably
 * means they are sarcasm and belong in the name — and `happy "fantasy"` almost
 * certainly does. Nothing in the text distinguishes them, so Wumpy asks and
 * offers both readings. One click is cheaper than being wrong, and far cheaper
 * than a reasoning model deliberating about it for two minutes.
 */
function readTitle(raw: string): { title: string; alternative: string | null } {
  const trimmed = trimTail(raw)
  const anyQuote = new RegExp(`${QUOTE_OPEN}|${QUOTE_CLOSE}`, 'g')
  if (!anyQuote.test(trimmed)) return { title: trimmed, alternative: null }

  const stripped = trimmed.replace(new RegExp(`${QUOTE_OPEN}|${QUOTE_CLOSE}`, 'g'), '').trim()
  // Only worth asking when the two readings actually differ.
  if (!stripped || stripped === trimmed) return { title: trimmed, alternative: null }
  return { title: trimmed, alternative: stripped }
}

const INTENTS: Intent[] = [
  {
    /*
     * "rename this chat to X" / "call this chat X" / "retitle the conversation as X"
     *
     * The word chat or conversation is REQUIRED. It used to be optional, and
     * the object could be a bare "it" or "this" - so "rename it to Bob",
     * said one turn after talking about a file, renamed the CHAT and never
     * reached the model. Short-circuiting a model is only free when the
     * phrasing cannot mean anything else; anything vaguer goes to the model,
     * which answers a chat rename with /rename anyway.
     */
    pattern:
      /^(?:please\s+)?(?:can\s+you\s+)?(?:rename|retitle|call|name)\s+(?:this\s+|the\s+|that\s+|my\s+)?(?:chat|conversation)\s*(?:to|as)?\s+(.{2,60})$/i,
    build: (m) => {
      const { title, alternative } = readTitle(m[1])
      // "rename this chat" with no name is a request for the picker, not a title.
      if (!title || /^(a\s+)?(better|good|new)\s+(name|title)$/i.test(title)) return null
      // Ambiguous quoting: let the user say which they meant.
      if (alternative) {
        return {
          kind: 'renameChoice',
          question: 'Which did you mean?',
          options: [alternative, title]
        }
      }
      return { kind: 'rename', title }
    }
  },
  {
    pattern: /^(?:please\s+)?(?:start|begin|open|make)\s+(?:a\s+)?new\s+(?:chat|conversation)\.?$/i,
    build: () => ({ kind: 'new' })
  },
  {
    pattern: /^(?:please\s+)?(?:clear|reset)\s+(?:this\s+)?(?:chat|conversation)\.?$/i,
    build: () => ({ kind: 'new' })
  },
  {
    pattern:
      /^(?:please\s+)?(?:compact|summarise|summarize)\s+(?:this\s+)?(?:chat|conversation|context)\.?$/i,
    build: () => ({ kind: 'compact' })
  },
  {
    /*
     * "history" on its own is not this. PowerShell has a history, the
     * browser has a history, and the composer has one of its own - so a bare
     * "show history" went to the chat picker instead of being answered. It
     * has to be said to be the chats'.
     */
    pattern:
      /^(?:please\s+)?(?:show|list|open)\s+(?:me\s+)?(?:my\s+|the\s+)?(?:saved\s+)?(?:chats|conversations|chat history|conversation history)\.?$/i,
    build: () => ({ kind: 'resume' })
  },
  {
    /*
     * "listen to the meeting" / "listen and summarise content in this
     * meeting" / "take notes of this call"
     *
     * THIS IS THE ONLY WAY IN NOW. There is no `/listen` - see commands.ts,
     * where it was removed in these words: "remove the command, i like it
     * when i ask it directly." So this pattern is not a convenience over a
     * command any more, and a sentence it fails to recognise is not a user
     * falling back on typing a slash. It is the model being asked to listen,
     * having no way to, and saying so - which is how this was reported:
     * "listen and summarise content in this meeting" answered with "I can't
     * listen to audio directly."
     *
     * So the words between the verb and the object are allowed to be
     * anything. What is NOT relaxed is the object itself, for the same
     * reason the rename intent needs the word "chat": a bare "listen" is a
     * thing people say to each other mid-sentence, and short-circuiting the
     * model is only free when the phrasing cannot mean anything else.
     */
    pattern:
      /^(?:please\s+)?(?:can\s+you\s+)?(?:start\s+)?(?:listen(?:ing)?|take\s+notes?)\b.*?\b(?:meeting|call|conversation|audio|sound|speakers?|microphone|mic)\b.*$/i,
    build: (m) => {
      const said = m.input ?? ''
      /*
       * Except when the thing to listen to is a THING.
       *
       * "listen to this recording", "can you listen to this audio file" -
       * both reach the object word and neither means open a live tap on the
       * speakers. The model handles those, and handles them well: a file is
       * something it can be pointed at.
       */
      if (/\b(?:file|files|recording|recordings|mp3|m4a|wav|clip|video|voicemail|attachment)\b/i.test(said)) {
        return null
      }
      /*
       * And it listens to what was actually named.
       *
       * "listen to my speakers" used to start BOTH taps, microphone
       * included, because every phrasing built the same toggle. In a call
       * that is every other person in the room, opened by a sentence that
       * asked for one side of it. Naming a source is the one argument the
       * command had that was worth keeping, so it is kept - said in words
       * rather than as `/listen mic`.
       */
      const mic = /\b(?:microphone|mic)\b/i.test(said)
      const speakers = /\b(?:speakers?|system)\b/i.test(said)
      if (mic && !speakers) return { kind: 'listen', what: 'source', ask: 'mic' }
      if (speakers && !mic) return { kind: 'listen', what: 'source', ask: 'system' }
      /* A meeting is both halves of a meeting, which is also what somebody
         who named neither is asking for. */
      return { kind: 'listen', what: 'toggle', ask: '' }
    }
  },
  {
    /* And the other end of it, where a bare "stop listening" IS unambiguous:
       nothing else in this app listens. */
    pattern:
      /^(?:please\s+)?(?:stop|end|finish)\s+(?:listening|the\s+(?:meeting|call|recording)|taking\s+notes?)\.?$/i,
    build: () => ({ kind: 'listen', what: 'stop', ask: '' })
  }
]

/**
 * Returns the action to run instead of sending to the model, or null when the
 * text is an ordinary message.
 */
export function matchIntent(text: string): CommandAction | null {
  const trimmed = text.trim()
  // Slash commands are handled by the parser; questions are for the model.
  if (!trimmed || trimmed.startsWith('/') || trimmed.endsWith('?')) return null
  // Only short, direct phrasings. A paragraph that happens to contain "rename"
  // is a conversation, not a command.
  if (trimmed.length > 80 || trimmed.split(/\s+/).length > 14) return null

  for (const intent of INTENTS) {
    const m = trimmed.match(intent.pattern)
    if (!m) continue
    const action = intent.build(m)
    if (action) return action
  }
  return null
}
