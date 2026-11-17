/**
 * The skills folder: one markdown file per skill, the user's to read, edit
 * and delete like any other file. See @shared/skills for what a skill is
 * and when one is used.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { MAX_SKILL_CHARS, parseSkill, skillFacts, skillFile, skillName, type Skill } from '@shared/skills'

/** More than anyone writes by hand; a cap so a runaway loop cannot fill the facts. */
const MAX_SKILLS = 40

export class SkillStore {
  readonly dir = join(app.getPath('userData'), 'skills')

  list(): Skill[] {
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.md'))
    } catch {
      return []
    }
    const out: Skill[] = []
    for (const file of files.sort().slice(0, MAX_SKILLS)) {
      try {
        const s = parseSkill(file.replace(/\.md$/i, ''), readFileSync(join(this.dir, file), 'utf8'))
        if (s.name && s.body) out.push(s)
      } catch {
        /* Unreadable is the same as absent: a skill is a convenience. */
      }
    }
    return out
  }

  /** Makes or replaces one; an empty body removes it. */
  save(raw: { name: string; description?: string; triggers?: string[]; body: string }): {
    ok: boolean
    why: string
    name: string
    did: 'saved' | 'replaced' | 'removed'
  } {
    const name = skillName(raw?.name ?? '')
    if (!name) return { ok: false, why: 'A skill needs a name.', name: '', did: 'saved' }
    const file = join(this.dir, `${name}.md`)
    const existed = existsSync(file)
    try {
      const body = (raw.body ?? '').trim()
      if (!body) {
        rmSync(file, { force: true })
        return { ok: true, why: '', name, did: 'removed' }
      }
      if (body.length > MAX_SKILL_CHARS * 2) {
        return { ok: false, why: `That skill is too long to save (${body.length} characters).`, name, did: 'saved' }
      }
      if (!existed && this.list().length >= MAX_SKILLS) {
        return { ok: false, why: `There are already ${MAX_SKILLS} skills.`, name, did: 'saved' }
      }
      mkdirSync(this.dir, { recursive: true })
      const triggers = (raw.triggers ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
      writeAtomic(
        file,
        skillFile({
          name,
          description: (raw.description ?? '').trim() || name.replace(/-/g, ' '),
          triggers: triggers.length ? triggers : [name.replace(/-/g, ' ')],
          body
        })
      )
      return { ok: true, why: '', name, did: existed ? 'replaced' : 'saved' }
    } catch (err) {
      return { ok: false, why: `Could not save it: ${(err as Error)?.name ?? 'unknown error'}`, name, did: 'saved' }
    }
  }

  /** The lines for this turn's facts, from everything they have said in the chat. */
  forPrompt(said: readonly string[]): string[] {
    return skillFacts(this.list(), said, this.dir)
  }
}
