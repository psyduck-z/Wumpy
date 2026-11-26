import { STAMP } from './sent'
/**
 * What the model writes for Wumpy rather than for them: three tags, never
 * shown or read aloud.
 *
 * <keep>...</keep> is a note to itself. "We were playing hangman and I told
 * it to give me a word with vowels, but it kept on saying that no vowels."
 * It could not have done better. A model has no memory between turns except
 * the conversation, so a word it chose and did not write down was gone by
 * the next guess, and every "is there an E?" was answered about a word it
 * was making up on the spot. Its reasoning does not help either: that is
 * thrown away after each turn. So it may write the hangman word, the number
 * to guess, the riddle's answer into its answer, out of sight, and the note
 * goes back to it with the rest of the conversation.
 *
 * <remember>...</remember> is a line for their notes (context.ts), saved
 * when the answer is finished and shown as saved: "remember that I like
 * tea" no longer needs the command typed.
 *
 * <skill name="..." ...>...</skill> is a skill (@shared/skills), made or
 * changed when they ask for one.
 *
 * An unclosed tag, still being written, is hidden to the end.
 *
 * Pure, for scripts/check-skills.mjs and check-speakahead.mjs.
 */
const PRIVATE = /<(keep|remember|skill)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi
/* A tag still being written, cut off before its ">": "<rem", "<skill name=".
   Never a bare "<", which is "a < b" at the end of an answer. */
const OPENING = /<(?:k(?:e(?:e(?:p)?)?)?|r(?:e(?:m(?:e(?:m(?:b(?:e(?:r)?)?)?)?)?)?)?|s(?:k(?:i(?:l(?:l)?)?)?)?)(?:\s[^>]*)?$/i

export function withoutKept(text: string): string {
  const shown = text.includes('<') ? text.replace(PRIVATE, '').replace(OPENING, '').replace(/^\s+/, '') : text
  /* And a "[sent ...]" stamp, should the answer copy the one on their
     messages (see @shared/sent): the app's, not something to show or say. */
  return shown.startsWith('[sent ') ? shown.replace(STAMP, '') : shown
}

export interface Saves {
  remember: string[]
  skills: Array<{ name: string; description: string; triggers: string[]; body: string; argumentHint?: string; aliases?: string[] }>
}

function attribute(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

/** What a finished answer asked to be saved. Closed tags only: a cut-off one saves nothing. */
export function savesIn(text: string): Saves {
  const out: Saves = { remember: [], skills: [] }
  for (const m of text.matchAll(/<remember\b[^>]*>([\s\S]*?)<\/remember>/gi)) {
    const fact = m[1].replace(/\s+/g, ' ').trim()
    if (fact && fact.length <= 300) out.remember.push(fact)
  }
  /* Attributes may hold a ">" inside quotes: argument-hint="<topic>". */
  for (const m of text.matchAll(/<skill\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/skill>/gi)) {
    const name = attribute(m[1], 'name')
    if (!name) continue
    out.skills.push({
      name,
      description: attribute(m[1], 'description'),
      triggers: attribute(m[1], 'triggers')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      body: m[2].trim(),
      ...(attribute(m[1], 'argument-hint') ? { argumentHint: attribute(m[1], 'argument-hint') } : {}),
      ...(attribute(m[1], 'aliases')
        ? { aliases: attribute(m[1], 'aliases').split(',').map((a) => a.trim()).filter(Boolean) }
        : {})
    })
  }
  return out
}
