/**
 * Skills shared between devices, through an unlisted gist on their own
 * GitHub account. See @shared/skillsync for how the two sides are merged.
 *
 * The token: one they gave with `/sync key <token>` (kept encrypted, like
 * the model keys), or else the GitHub CLI's own if `gh` is signed in on this
 * machine - which is the case on the laptop Wumpy is developed on, so there
 * it needs nothing at all.
 */
import { app, safeStorage } from 'electron'
import { NOT_SECURE, storesSecurely } from './keys'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from './atomic'
import type { SkillStore } from './skills'
import { parseSkill } from '@shared/skills'
import {
  GIST_DESCRIPTION,
  MANIFEST,
  README,
  gistFile,
  plan,
  readManifest,
  summary,
  type Manifest
} from '@shared/skillsync'

const API = 'https://api.github.com'

interface Gist {
  id: string
  description: string | null
  html_url?: string
  owner?: { login?: string } | null
  files: Record<string, { filename: string; content?: string; truncated?: boolean; raw_url?: string } | null>
}

interface SyncState {
  gist?: string
  /** The GitHub account the gist belongs to. */
  account?: string
  /** Each skill's hash when the two sides last agreed; null, agreed deleted. */
  base: Record<string, string | null>
}

export interface SyncResult {
  ok: boolean
  message: string
  changed: boolean
}

export class SkillSync {
  private readonly tokenFile = join(app.getPath('userData'), 'github-token.bin')
  private running: Promise<SyncResult> | null = null

  constructor(
    private readonly store: SkillStore,
    private readonly log: (line: string) => void
  ) {}

  private get stateFile(): string {
    return join(this.store.dir, '.sync.json')
  }

  /* -------------------------------------------------------------- the token */

  /** Keeps a token they gave, encrypted. An empty one forgets it. */
  setToken(token: string): { ok: boolean; why: string } {
    const t = token.trim()
    if (!t) {
      rmSync(this.tokenFile, { force: true })
      return { ok: true, why: '' }
    }
    if (!/^(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(t)) {
      return { ok: false, why: 'That does not look like a GitHub token (they start with ghp_ or github_pat_).' }
    }
    if (!storesSecurely()) return { ok: false, why: NOT_SECURE }
    try {
      writeAtomic(this.tokenFile, safeStorage.encryptString(t))
      return { ok: true, why: '' }
    } catch {
      return { ok: false, why: 'It could not be saved.' }
    }
  }

  private stored(): string | null {
    try {
      return safeStorage.decryptString(readFileSync(this.tokenFile)).trim() || null
    } catch {
      return null
    }
  }

  /** Where `gh` might be when Wumpy was started from a launcher, not a shell. */
  private ghPaths(): string[] {
    const home = homedir()
    return process.platform === 'win32'
      ? ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe', join(home, 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe')]
      : ['gh', join(home, '.local', 'share', 'mise', 'shims', 'gh'), join(home, '.local', 'bin', 'gh'), '/usr/local/bin/gh', '/usr/bin/gh', '/opt/homebrew/bin/gh']
  }

  private async fromGh(): Promise<string | null> {
    for (const gh of this.ghPaths()) {
      if (gh !== 'gh' && !existsSync(gh)) continue
      const token = await new Promise<string | null>((resolve) => {
        execFile(gh, ['auth', 'token'], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null))
      })
      if (token) return token
    }
    return null
  }

  async token(): Promise<{ token: string; from: 'kept' | 'gh' } | null> {
    const kept = this.stored()
    if (kept) return { token: kept, from: 'kept' }
    const gh = await this.fromGh()
    return gh ? { token: gh, from: 'gh' } : null
  }

  /* ------------------------------------------------------------- the gist */

  private async call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Wumpy',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      const why =
        res.status === 401
          ? 'GitHub did not accept the token'
          : res.status === 403 || res.status === 404
            ? 'the token cannot use gists (it needs the "gist" scope)'
            : `GitHub answered ${res.status}`
      throw new Error(why)
    }
    return (await res.json()) as T
  }

  private state(): SyncState {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<SyncState>
      return { gist: s.gist, account: s.account, base: s.base ?? {} }
    } catch {
      return { base: {} }
    }
  }

  /** Which GitHub account this device last synced with, for /sync status. */
  status(): { account?: string } {
    const account = this.state().account
    return account ? { account } : {}
  }

  private saveState(s: SyncState): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify(s, null, 2))
    } catch {
      /* The next sync merges from scratch, which is safe: nothing is lost. */
    }
  }

  /**
   * This account's skills gist: the one remembered, else found by its
   * description, else made. Only ever one of `account`'s own: an unlisted
   * gist can be read by anyone with its id, so the one remembered may well
   * load when it is somebody else's.
   */
  private async gist(token: string, account: string, remembered?: string): Promise<Gist> {
    if (remembered) {
      try {
        const g = await this.call<Gist>(token, `/gists/${remembered}`)
        if (g.owner?.login === account) return g
      } catch {
        /* Deleted: look for it again. */
      }
    }
    for (let page = 1; page <= 5; page++) {
      const list = await this.call<Gist[]>(token, `/gists?per_page=100&page=${page}`)
      const found = list.find((g) => g.description === GIST_DESCRIPTION)
      if (found) return this.call<Gist>(token, `/gists/${found.id}`)
      if (list.length < 100) break
    }
    return this.call<Gist>(token, '/gists', {
      method: 'POST',
      body: {
        description: GIST_DESCRIPTION,
        public: false,
        files: {
          [README]: {
            content:
              '# Wumpy skills\n\nKept in step by Wumpy on each of your devices: one file per skill, ' +
              'and wumpy-skills.json saying when each changed. Edit them in Wumpy rather than here.\n'
          },
          [MANIFEST]: { content: JSON.stringify({ version: 1, skills: {} }, null, 2) }
        }
      }
    })
  }

  private async content(token: string, gist: Gist, file: string): Promise<string | null> {
    const f = gist.files[file]
    if (!f) return null
    if (!f.truncated && typeof f.content === 'string') return f.content
    if (!f.raw_url) return null
    const res = await fetch(f.raw_url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    return res.ok ? res.text() : null
  }

  /* -------------------------------------------------------------- syncing */

  /** One sync; a second call while one runs waits for that one. */
  sync(): Promise<SyncResult> {
    if (!this.running) this.running = this.once().finally(() => (this.running = null))
    return this.running
  }

  private async once(): Promise<SyncResult> {
    const auth = await this.token()
    if (!auth) {
      return {
        ok: false,
        changed: false,
        message: 'Not signed in to GitHub. Make a [token with the gist scope](https://github.com/settings/tokens/new?scopes=gist&description=Wumpy%20skills), then `/sync key <token>`.'
      }
    }
    try {
      const me = await this.call<{ login?: string }>(auth.token, '/user')
      const account = String(me?.login ?? '')
      if (!account) throw new Error('GitHub did not say whose token this is')
      const st = this.state()
      const gist = await this.gist(auth.token, account, st.account === account ? st.gist : undefined)
      /*
       * What was last agreed only holds for the gist it was agreed with. A
       * different one - another account's (someone else's token, typed into
       * this Wumpy), or a new one because theirs was deleted - starts empty,
       * and against the old agreement an empty gist reads as "every skill was
       * deleted on another device": this device's skills would be deleted.
       * From nothing, the two sides are put together instead, and nothing is
       * lost.
       */
      if (gist.id !== st.gist || st.account !== account) {
        if (st.gist) this.log(`[skills] sync: a different gist (${account}'s), merging from scratch`)
        st.base = {}
      }
      const manifest = readManifest(await this.content(auth.token, gist, MANIFEST))
      const localView = this.store.syncView(new Set([...Object.keys(manifest.skills), ...Object.keys(st.base)]))
      const local = Object.fromEntries(Object.entries(localView).map(([n, v]) => [n, { hash: v.hash, at: v.at }]))
      const steps = plan(local, manifest.skills, st.base)

      const files: Record<string, { content: string } | null> = {}
      const next: Manifest = { version: 1, skills: { ...manifest.skills } }
      const base: Record<string, string | null> = { ...st.base }
      let localChanged = false
      const now = Date.now()
      for (const [name, step] of Object.entries(steps)) {
        if (step === 'same') {
          base[name] = local[name]?.hash ?? null
          continue
        }
        if (step === 'upload') {
          files[gistFile(name)] = { content: localView[name].text }
          next.skills[name] = { hash: local[name].hash, at: local[name].at }
          base[name] = local[name].hash
        } else if (step === 'deleteRemote') {
          if (gist.files[gistFile(name)]) files[gistFile(name)] = null
          next.skills[name] = { hash: '', at: now, deleted: true }
          base[name] = null
        } else if (step === 'download') {
          const text = await this.content(auth.token, gist, gistFile(name))
          /* What came down must be the skill it says it is. */
          if (text && parseSkill(name, text).name === name && this.store.put(name, text)) {
            base[name] = manifest.skills[name].hash
            localChanged = true
          }
        } else if (step === 'deleteLocal') {
          if (this.store.drop(name)) {
            base[name] = null
            localChanged = true
          }
        }
      }
      const pushing = Object.keys(files).length > 0
      if (pushing) {
        files[MANIFEST] = { content: JSON.stringify(next, null, 2) }
        await this.call(auth.token, `/gists/${gist.id}`, { method: 'PATCH', body: { files } })
      }
      this.saveState({ gist: gist.id, account, base })
      const said = summary(steps)
      this.log(`[skills] sync: ${said.line}`)
      return { ok: true, changed: localChanged, message: said.line }
    } catch (err) {
      const why = String((err as Error)?.message ?? err).slice(0, 200)
      this.log(`[skills] sync failed: ${why}`)
      return { ok: false, changed: false, message: `Could not sync skills: ${why}.` }
    }
  }
}
