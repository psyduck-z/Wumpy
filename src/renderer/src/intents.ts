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

/** Strips quotes and trailing punctuation from a captured title. */
function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[.!?]+$/, '')
    .trim()
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
      const title = cleanTitle(m[1])
      // "rename this chat" with no name is a request for the picker, not a title.
      if (!title || /^(a\s+)?(better|good|new)\s+(name|title)$/i.test(title)) return null
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
