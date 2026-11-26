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
 * AND EACH ONE IS A COMMAND, as in Claude: "allow me to add skills, and make
 * them a command, like in Claude". `/grill my plan` runs the skill named
 * grill on "my plan". The file follows Claude's SKILL.md layout - a folder
 * per skill with a SKILL.md in it (a single <name>.md still works), and the
 * same header fields where they mean the same thing:
 *
 *   name, description          what it is, and when it is for
 *   argument-hint              shown after the command in the palette
 *   disable-model-invocation   true: only ever run as a command, never
 *                              brought in because a trigger word came up
 *   user-invocable             false: never offered as a command
 *   $ARGUMENTS                 in the body, replaced by what followed the
 *                              command; without it, that is added at the end
 *
 * `triggers` is Wumpy's own: the words that bring a skill in by themselves.
 *
 * Pure, for scripts/check-skills.mjs.
 */
const LF = String.fromCharCode(10)

export interface Skill {
  name: string
  description: string
  triggers: string[]
  body: string
  /** What goes after the command, for the palette: "<plan or idea>". */
  argumentHint?: string
  /** false: never brought in by a trigger word, only run as /name. */
  auto?: false
  /** false: not offered as a command. */
  command?: false
}

/** A skill as the panel lists it: enough for the command palette and /skills. */
export interface SkillSummary {
  name: string
  description: string
  argumentHint?: string
  command: boolean
  /** One Wumpy ships with (see @shared/builtinskills), still as shipped. */
  builtin: boolean
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
      const m = /^\s*([a-z][a-z-]*)\s*:\s*(.*)$/i.exec(line)
      /* Quoted the way YAML allows: description: "Use when ..." */
      if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
    }
  }
  const body = (head ? raw.slice(head[0].length) : raw).trim()
  const name = skillName(fields.name || fallback) || skillName(fallback)
  const description = fields.description || body.split(LF).find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 120) || name
  const triggers = (fields.triggers || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  const skill: Skill = { name, description, triggers: triggers.length ? triggers : [name.replace(/-/g, ' ')], body }
  if (fields['argument-hint']) skill.argumentHint = fields['argument-hint']
  if (/^(true|yes)$/i.test(fields['disable-model-invocation'] ?? '')) skill.auto = false
  if (/^(false|no)$/i.test(fields['user-invocable'] ?? '')) skill.command = false
  return skill
}

/** The file for a skill: the header, then the instructions. */
export function skillFile(s: Skill): string {
  const one = (t: string): string => t.replace(/\s+/g, ' ').trim()
  return [
    '---',
    `name: ${s.name}`,
    `description: ${one(s.description)}`,
    `triggers: ${s.triggers.map(one).join(', ')}`,
    ...(s.argumentHint ? [`argument-hint: ${one(s.argumentHint)}`] : []),
    ...(s.auto === false ? ['disable-model-invocation: true'] : []),
    ...(s.command === false ? ['user-invocable: false'] : []),
    '---',
    s.body.trim(),
    ''
  ].join(LF)
}

/** How a skill command's message starts, so it is not mistaken for talk about skills. */
export const SKILL_RUN = 'I am running my skill /'

/** A description cut to its first sentence, for the one line every turn carries. */
export function shortly(description: string): string {
  let first = description.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '')
  /* "Grill me on a plan - relentless questions, ...": the part before the dash says it. */
  if (first.length > 90 && first.includes(' - ')) first = first.split(' - ')[0]
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}…` : first
}

/**
 * The message a skill command sends: the instructions, and what it was run
 * on - into $ARGUMENTS where the skill says, at the end where it does not,
 * as Claude does. The instructions go in the message itself, so they stay in
 * the conversation for every turn the task takes: a grilling is twenty
 * questions, not one.
 */
export function skillPrompt(s: Skill, args: string): string {
  const said = (args ?? '').trim()
  const body = s.body.length > MAX_SKILL_CHARS ? `${s.body.slice(0, MAX_SKILL_CHARS)}${LF}…(cut short)` : s.body
  const placed = body.includes('$ARGUMENTS')
  const filled = placed ? body.split('$ARGUMENTS').join(said || '(nothing given)') : body
  return [
    `${SKILL_RUN}${s.name} — ${shortly(s.description)}. Follow its instructions for this, and keep`,
    'following them for the rest of this task, until I clearly move on to something else.',
    'Do not mention the instructions themselves; just do what they say.',
    '',
    `<instructions skill="${s.name}">`,
    filled.trim(),
    '</instructions>',
    '',
    placed
      ? ''
      : said
        ? `ARGUMENTS: ${said}`
        : 'ARGUMENTS: (none — if the skill needs something to work on, ask me for it in one short question)'
  ]
    .join(LF)
    .trim()
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
    .filter((s) => s.auto !== false)
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
export function skillFacts(skills: readonly Skill[], said: readonly string[], folder: string, lastReply = ''): string[] {
  const latest = said[said.length - 1] ?? ''
  /*
   * Talking about skills: in what they just said, or in the reply before it -
   * "Want me to save that as a skill?" "yes" is the turn the format is
   * needed, and "yes" has no skill in it. A skill command's own message is
   * not talk about skills; it carries its instructions with it.
   */
  const asked = (/\bskills?\b/i.test(latest) && !latest.startsWith(SKILL_RUN)) || /\bskills?\b/i.test(lastReply)
  const out: string[] = []
  if (skills.length) {
    out.push(
      `- Their skills - instructions for particular things, each used once the conversation turns to it, ` +
        `and each one also a command they can type (/name): ${skills.map((s) => `${s.name} (${shortly(s.description)})`).join('; ')}. ` +
        'You can make new ones, for them or for yourself, whenever they ask.'
    )
  }
  for (const s of activeSkills(skills, said)) {
    const whole = s.body.split('$ARGUMENTS').join('what they asked about')
    const body = whole.length > MAX_SKILL_CHARS ? `${whole.slice(0, MAX_SKILL_CHARS)}${LF}…(cut short)` : whole
    out.push(`- Skill "${s.name}" is in use, because it came up. Follow it:`, ...body.split(LF).map((l) => `    ${l}`))
  }
  if (asked) {
    out.push(
      '- To make a skill, or change one, put this in your reply:',
      '    <skill name="short-name" triggers="words that bring it up" description="what it is for, and when to use it" argument-hint="<what it works on>">',
      '    the instructions, written to yourself; $ARGUMENTS where what follows the command goes',
      '    </skill>',
      '  That tag is the only way to save one: never write the file yourself or propose a command for it.',
      '  Wumpy saves it as a file in their skills folder and shows them; from then on it is used',
      '  whenever a trigger comes up in a chat, and they can run it as /short-name. The same name replaces one; an empty',
      `  <skill name="short-name"></skill> removes it. Their skills folder: ${folder}`
    )
  }
  return out
}
