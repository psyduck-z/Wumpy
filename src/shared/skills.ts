/**
 * Skills: instructions for particular things, in files the user owns.
 *
 * "Can I hold like local memory kind of? Like local skills like Claude." The
 * notes file (context.ts) is a dozen facts, sent with every message. A skill
 * is longer - how to run a game of hangman out loud, how they like a summary
 * written, the steps of their homework routine - and is only worth its
 * tokens when the conversation is about it. So every turn carries one line
 * per skill, and the whole of a skill comes in once a word that brings it
 * up has been said in the chat, and stays for the rest of it: a game of
 * hangman is "hangman" once and "is there an E?" for twenty turns after.
 *
 * A skill is a markdown file in the skills folder, with a little header:
 *
 *   ---
 *   name: hangman
 *   description: Playing hangman out loud
 *   triggers: hangman, guess the word
 *   ---
 *   The instructions, written to Wumpy.
 *
 * Written by hand, or by the model with a <skill> tag (see @shared/kept)
 * when they ask it to make one.
 *
 * Pure, for scripts/check-skills.mjs.
 */
const LF = String.fromCharCode(10)

export interface Skill {
  name: string
  description: string
  triggers: string[]
  body: string
}

/** Longest instructions sent; a skill is a page, not a manual. */
export const MAX_SKILL_CHARS = 4000
/** Most skills in use at once, newest-mentioned first. */
export const MAX_ACTIVE = 3

/** "Hangman Rules!" -> "hangman-rules": a file name that is the same on every system. */
export function skillName(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** A file's text as a skill; `fallback` is its file name, for one written without a header. */
export function parseSkill(fallback: string, text: string): Skill {
  const raw = (text ?? '').replace(/\r\n/g, LF)
  const head = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  const fields: Record<string, string> = {}
  if (head) {
    for (const line of head[1].split(LF)) {
      const m = /^\s*([a-z]+)\s*:\s*(.*)$/i.exec(line)
      if (m) fields[m[1].toLowerCase()] = m[2].trim()
    }
  }
  const body = (head ? raw.slice(head[0].length) : raw).trim()
  const name = skillName(fields.name || fallback) || skillName(fallback)
  const description = fields.description || body.split(LF).find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 120) || name
  const triggers = (fields.triggers || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  return { name, description, triggers: triggers.length ? triggers : [name.replace(/-/g, ' ')], body }
}

/** The file for a skill: the header, then the instructions. */
export function skillFile(s: Skill): string {
  const one = (t: string): string => t.replace(/\s+/g, ' ').trim()
  return [
    '---',
    `name: ${s.name}`,
    `description: ${one(s.description)}`,
    `triggers: ${s.triggers.map(one).join(', ')}`,
    '---',
    s.body.trim(),
    ''
  ].join(LF)
}

/** Whether `phrase` is said in `text` as words, not inside other words. */
function says(text: string, phrase: string): boolean {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (!words.length) return false
  return new RegExp(`\\b${words.join('[^a-z0-9]+')}\\b`).test(text.toLowerCase())
}

/**
 * The skills that came up in what they have said in this chat, the most
 * recently mentioned first - so a skill stays in use for the whole of a
 * game, and a new one takes the place of the oldest.
 */
export function activeSkills(skills: readonly Skill[], said: readonly string[]): Skill[] {
  const last = (s: Skill): number => {
    for (let i = said.length - 1; i >= 0; i--) if (s.triggers.some((t) => says(said[i], t))) return i
    return -1
  }
  return skills
    .map((s) => ({ s, at: last(s) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ACTIVE)
    .map((x) => x.s)
}

/**
 * What the model is told: one line listing every skill, the whole of each
 * one in use, and - when they are talking about skills - how to make one.
 */
export function skillFacts(skills: readonly Skill[], said: readonly string[], folder: string): string[] {
  const latest = said[said.length - 1] ?? ''
  const asked = /\bskills?\b/i.test(latest)
  const out: string[] = []
  if (skills.length) {
    out.push(
      `- Their skills - instructions for particular things, each used once the conversation turns to it: ${skills
        .map((s) => `${s.name} (${s.description})`)
        .join('; ')}.`
    )
  }
  for (const s of activeSkills(skills, said)) {
    const body = s.body.length > MAX_SKILL_CHARS ? `${s.body.slice(0, MAX_SKILL_CHARS)}${LF}…(cut short)` : s.body
    out.push(`- Skill "${s.name}" is in use, because it came up. Follow it:`, ...body.split(LF).map((l) => `    ${l}`))
  }
  if (asked) {
    out.push(
      '- To make a skill, or change one, put this in your reply:',
      '    <skill name="short-name" triggers="words that bring it up" description="what it is for, in a line">',
      '    the instructions, written to yourself',
      '    </skill>',
      '  Wumpy saves it as a file in their skills folder and shows them; from then on it is used',
      '  whenever a trigger comes up in a chat. The same name replaces one; an empty',
      `  <skill name="short-name"></skill> removes it. Their skills folder: ${folder}`
    )
  }
  return out
}
