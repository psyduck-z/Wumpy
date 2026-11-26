/**
 * The skills folder: one skill per folder with a SKILL.md in it, as Claude
 * lays them out (or a single <name>.md, as Wumpy first did), the user's to
 * read, edit and delete like any other file. See @shared/skills for what a
 * skill is and when one is used, and @shared/builtinskills for the ones
 * Wumpy ships with.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import { BUILTIN_SKILLS } from '@shared/builtinskills'
import {
  MAX_SKILL_CHARS,
  parseSkill,
  skillFacts,
  skillFile,
  skillName,
  type Skill,
  type SkillSummary
} from '@shared/skills'

/** More than anyone writes by hand; a cap so a runaway loop cannot fill the facts. */
const MAX_SKILLS = 60

/** Which shipped skills have been put in the folder, and what each said then. */
const SHIPPED = '.builtin.json'

const hash = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)

export class SkillStore {
  readonly dir = join(app.getPath('userData'), 'skills')
  private seeded = false

  /** The file a skill lives in: its folder's SKILL.md, or the older single file. */
  private fileOf(name: string): string | null {
    const folder = join(this.dir, name, 'SKILL.md')
    if (existsSync(folder)) return folder
    const flat = join(this.dir, `${name}.md`)
    return existsSync(flat) ? flat : null
  }

  private shipped(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(join(this.dir, SHIPPED), 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  /**
   * Puts the shipped skills in the folder: once each, never over one of the
   * user's own, and never back after it was deleted. One still exactly as
   * shipped is brought up to date when the shipped text changes.
   */
  seed(): void {
    if (this.seeded) return
    this.seeded = true
    try {
      mkdirSync(this.dir, { recursive: true })
      const record = this.shipped()
      let changed = false
      for (const [name, text] of Object.entries(BUILTIN_SKILLS)) {
        const now = hash(text)
        const file = this.fileOf(name)
        if (!(name in record)) {
          /* Theirs already, by that name: theirs it stays. */
          if (!file) {
            mkdirSync(join(this.dir, name), { recursive: true })
            writeAtomic(join(this.dir, name, 'SKILL.md'), text)
            record[name] = now
          } else record[name] = 'theirs'
          changed = true
          continue
        }
        if (!file || record[name] === now || record[name] === 'theirs') continue
        /* Untouched since it was shipped: the new text replaces it. */
        if (hash(readFileSync(file, 'utf8')) === record[name]) {
          writeAtomic(file, text)
          record[name] = now
          changed = true
        }
      }
      if (changed) writeAtomic(join(this.dir, SHIPPED), JSON.stringify(record, null, 2))
    } catch {
      /* A folder that cannot be written is a folder without the shipped skills. */
    }
  }

  list(): Skill[] {
    this.seed()
    let entries: string[] = []
    try {
      entries = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: Skill[] = []
    const seen = new Set<string>()
    for (const entry of entries.sort()) {
      if (entry.startsWith('.') || out.length >= MAX_SKILLS) continue
      const path = join(this.dir, entry)
      let file: string | null = null
      let fallback = entry
      try {
        if (statSync(path).isDirectory()) file = existsSync(join(path, 'SKILL.md')) ? join(path, 'SKILL.md') : null
        else if (entry.toLowerCase().endsWith('.md')) {
          file = path
          fallback = entry.replace(/\.md$/i, '')
        }
        if (!file) continue
        const s = parseSkill(fallback, readFileSync(file, 'utf8'))
        if (s.name && s.body && !seen.has(s.name)) {
          seen.add(s.name)
          out.push(s)
        }
      } catch {
        /* Unreadable is the same as absent: a skill is a convenience. */
      }
    }
    return out
  }

  /** One skill, by name, read fresh from its file. */
  get(name: string): Skill | null {
    const n = skillName(name)
    return this.list().find((s) => s.name === n) ?? null
  }

  /** What the panel needs for the command palette and /skills. */
  summaries(): SkillSummary[] {
    const record = this.shipped()
    return this.list().map((s) => {
      const file = this.fileOf(s.name)
      let builtin = false
      try {
        builtin = Boolean(file && record[s.name] && record[s.name] !== 'theirs' && hash(readFileSync(file, 'utf8')) === record[s.name])
      } catch {
        builtin = false
      }
      return {
        name: s.name,
        description: s.description,
        ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
        command: s.command !== false,
        builtin
      }
    })
  }

  /** Makes or replaces one; an empty body removes it. */
  save(raw: { name: string; description?: string; triggers?: string[]; body: string; argumentHint?: string }): {
    ok: boolean
    why: string
    name: string
    did: 'saved' | 'replaced' | 'removed'
  } {
    const name = skillName(raw?.name ?? '')
    if (!name) return { ok: false, why: 'A skill needs a name.', name: '', did: 'saved' }
    this.seed()
    const existing = this.fileOf(name)
    try {
      const body = (raw.body ?? '').trim()
      if (!body) {
        if (existing) rmSync(existing, { force: true })
        /* Its folder too, when that was all that was in it. */
        const folder = join(this.dir, name)
        try {
          if (existsSync(folder) && readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true })
        } catch {
          /* An empty folder left behind is harmless. */
        }
        return { ok: true, why: '', name, did: 'removed' }
      }
      if (body.length > MAX_SKILL_CHARS * 2) {
        return { ok: false, why: `That skill is too long to save (${body.length} characters).`, name, did: 'saved' }
      }
      if (!existing && this.list().length >= MAX_SKILLS) {
        return { ok: false, why: `There are already ${MAX_SKILLS} skills.`, name, did: 'saved' }
      }
      const triggers = (raw.triggers ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
      const text = skillFile({
        name,
        description: (raw.description ?? '').trim() || name.replace(/-/g, ' '),
        triggers: triggers.length ? triggers : [name.replace(/-/g, ' ')],
        body,
        ...(raw.argumentHint?.trim() ? { argumentHint: raw.argumentHint.trim() } : {})
      })
      /* New ones go in a folder of their own, as Claude lays them out. */
      const file = existing ?? join(this.dir, name, 'SKILL.md')
      mkdirSync(join(file, '..'), { recursive: true })
      writeAtomic(file, text)
      return { ok: true, why: '', name, did: existing ? 'replaced' : 'saved' }
    } catch (err) {
      return { ok: false, why: `Could not save it: ${(err as Error)?.name ?? 'unknown error'}`, name, did: 'saved' }
    }
  }

  /** The lines for this turn's facts, from everything they have said in the chat. */
  forPrompt(said: readonly string[]): string[] {
    return skillFacts(this.list(), said, this.dir)
  }
}
