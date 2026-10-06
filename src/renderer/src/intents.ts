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
const QUOTE_OPEN = "[\"'‘“]"
const QUOTE_CLOSE = "[\"'’”]"

/** Trailing sentence punctuation, which is never part of a name. */
function trimTail(raw: string): string {
  return raw.trim().replace(/[.!?]+$/, '').trim()
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

const TIER_WORDS: Record<string, 'flash' | 'fast' | 'thinker' | 'deep'> = {
  flash: 'flash',
  fast: 'fast',
  thinker: 'thinker',
  think: 'thinker',
  deep: 'deep',
  deepthinker: 'deep',
  'deep thinker': 'deep'
}

const INTENTS: Intent[] = [
  {
    // "rename this chat to X" / "call this chat X" / "retitle it to X"
    pattern:
      /^(?:please\s+)?(?:can\s+you\s+)?(?:rename|retitle|call|name)\s+(?:this\s+|the\s+|it\s+)?(?:chat|conversation)?\s*(?:to|as)?\s+(.{2,60})$/i,
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
    pattern: /^(?:please\s+)?(?:switch|change|go)\s+to\s+(.+?)\s*(?:tier|mode|model)?\.?$/i,
    build: (m) => {
      const key = m[1].trim().toLowerCase().replace(/[\s-]/g, '')
      const tier = TIER_WORDS[key]
      return tier ? { kind: 'tier', tier } : null
    }
  },
  {
    pattern: /^(?:please\s+)?(?:compact|summarise|summarize)\s+(?:this\s+)?(?:chat|conversation|context)\.?$/i,
    build: () => ({ kind: 'compact' })
  },
  {
    pattern:
      /^(?:please\s+)?(?:show|list|open)\s+(?:my\s+)?(?:saved\s+)?(?:chats|conversations|history)\.?$/i,
    build: () => ({ kind: 'resume' })
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
