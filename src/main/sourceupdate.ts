import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Updating the Linux install from its source folder.
 *
 * Windows gets a built release from GitHub (updater.ts). Linux has no
 * release: Wumpy here is built from the source folder by `npm run
 * install:linux` (scripts/install-linux.mjs), so "is there an update" means
 * two things - new commits on GitHub that have not been pulled, and edits in
 * the source folder made after the installed copy was built - and updating
 * means pulling (fast-forward only), building and installing, then
 * restarting into the new copy.
 *
 * Asked for as "a command called /update, that updates 1P if it's not auto
 * updated", with the check every 30 minutes. The check only looks; a rebuild
 * takes minutes of CPU and would install half-finished work from the folder
 * being developed in, so it is the user's /update (or the header button)
 * that builds.
 */

const ROOT = join(homedir(), '.local', 'share', 'wumpy')
/** Written by install-linux.mjs: the folder the installed copy was built from. */
export const SOURCE_FILE = join(ROOT, 'source.txt')

export interface SourceCheck {
  /** The source folder, or null when it cannot be found. */
  source: string | null
  /** Commits on the upstream branch not yet pulled. */
  behind: number
  /**
   * What to pull from: the branch's upstream, or origin's branch of the same
   * name when none is set (a clone made with `git init` + `remote add` has
   * none, and `@{u}` then fails - which read as "nothing new", forever).
   */
  pullFrom?: { remote: string; branch: string }
  /** Something that goes into the build was edited after the install. */
  edited: boolean
  /** Uncommitted changes to tracked files. */
  dirty: boolean
  /** When the installed copy was installed, ms; 0 if unknown. */
  installedAt: number
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

function isWumpySource(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    return pkg.name === 'wumpy' && existsSync(join(dir, 'scripts', 'install-linux.mjs'))
  } catch {
    return false
  }
}

/** The source folder: as recorded at install, else the usual places. */
export function findSource(): string | null {
  const home = homedir()
  const candidates = [
    process.env.WUMPY_SOURCE,
    readText(SOURCE_FILE),
    join(home, 'Dev', 'GitHub', 'Wumpy'),
    join(home, 'Dev', 'Wumpy'),
    join(home, 'Wumpy')
  ]
  for (const dir of candidates) if (dir && isWumpySource(dir)) return dir
  return null
}

/** When the installed copy went in, from its folder's name (app-<ms>). */
export function installedAt(): number {
  try {
    const m = /app-(\d+)\/?$/.exec(readlinkSync(join(ROOT, 'app')))
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/** What goes into a build. node_modules and dotfiles are not edits. */
const BUILD_INPUTS = [
  'src',
  'resources',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'electron.vite.config.ts',
  'electron.vite.config.mjs'
]

/** The newest edit among the build's inputs, ms. */
export function newestEdit(dir: string): number {
  let newest = 0
  const walk = (path: string, depth: number): void => {
    let st
    try {
      st = statSync(path)
    } catch {
      return
    }
    if (!st.isDirectory()) {
      newest = Math.max(newest, st.mtimeMs)
      return
    }
    if (depth > 12) return
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      walk(join(path, name), depth + 1)
    }
  }
  for (const top of BUILD_INPUTS) walk(join(dir, top), 0)
  return newest
}

/** Runs a program without a shell; never waits on a password prompt. */
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLine?: (line: string) => void
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ''}:/usr/local/bin:/usr/bin:/bin`,
          GIT_TERMINAL_PROMPT: '0',
          /* An Electron child would otherwise inherit being run as Electron. */
          ELECTRON_RUN_AS_NODE: undefined
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ ok: false, out: String((err as Error)?.message ?? err) })
      return
    }
    const take = (chunk: Buffer): void => {
      const text = chunk.toString()
      out = (out + text).slice(-8000)
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line.trim().slice(0, 300))
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => {
      out += `\n(stopped after ${Math.round(timeoutMs / 1000)}s)`
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, out: `${out}\n${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, out })
    })
  })
}

/** Looks: GitHub (a fetch, no merge) and the folder's edits since the install. */
export async function checkSource(fetch = true): Promise<SourceCheck> {
  const source = findSource()
  const at = installedAt()
  if (!source) return { source: null, behind: 0, edited: false, dirty: false, installedAt: at }
  let behind = 0
  let dirty = false
  let pullFrom: SourceCheck['pullFrom']
  if (existsSync(join(source, '.git'))) {
    if (fetch) await run('git', ['fetch', '--quiet'], source, 30_000)
    pullFrom = await upstreamOf(source)
    if (pullFrom) {
      const count = await run('git', ['rev-list', '--count', `HEAD..${pullFrom.remote}/${pullFrom.branch}`], source, 10_000)
      behind = count.ok ? Number.parseInt(count.out.trim(), 10) || 0 : 0
    }
    const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], source, 10_000)
    dirty = status.ok && status.out.trim().length > 0
  }
  const edited = at > 0 && newestEdit(source) > at
  return { source, behind, pullFrom, edited, dirty, installedAt: at }
}

/** The branch's upstream, else origin's branch of the same name if it exists. */
async function upstreamOf(source: string): Promise<{ remote: string; branch: string } | undefined> {
  const up = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], source, 10_000)
  const m = up.ok ? /^([^/\s]+)\/(\S+)$/.exec(up.out.trim()) : null
  if (m) return { remote: m[1], branch: m[2] }
  const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], source, 10_000)
  const branch = head.ok ? head.out.trim() : ''
  if (!branch || branch === 'HEAD') return undefined
  const there = await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], source, 10_000)
  return there.ok ? { remote: 'origin', branch } : undefined
}

/** What is new, in words; empty when nothing is. */
export function whatsNew(c: SourceCheck): string {
  const parts: string[] = []
  if (c.behind > 0) parts.push(`${c.behind} new commit${c.behind === 1 ? '' : 's'} on GitHub`)
  if (c.edited) parts.push('changes made in the source folder since it was installed')
  return parts.join(' and ')
}

/** The last few lines of a build's output, for saying why it failed. */
export function tail(out: string, lines = 6): string {
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n')
}

/**
 * Pull (fast-forward only, so nothing of the folder's is ever merged or
 * thrown away), build and install. Does not restart.
 */
export async function installFromSource(
  c: SourceCheck,
  log: (line: string) => void
): Promise<{ ok: boolean; message: string }> {
  const source = c.source
  if (!source) return { ok: false, message: 'The source folder could not be found.' }
  if (c.behind > 0) {
    log(`[update] pulling ${c.behind} commit(s) into ${source}`)
    const from = c.pullFrom ? [c.pullFrom.remote, c.pullFrom.branch] : []
    const pulled = await run('git', ['pull', '--ff-only', '--quiet', ...from], source, 120_000)
    if (!pulled.ok) {
      return {
        ok: false,
        message:
          `Could not pull the new commits into ${source} — nothing was changed. ` +
          `Git said:\n\n\`\`\`\n${tail(pulled.out)}\n\`\`\``
      }
    }
  }
  log(`[update] building and installing from ${source}`)
  let last = 0
  const built = await run('npm', ['run', 'install:linux'], source, 20 * 60_000, (line) => {
    /* A line every few seconds is plenty in wumpy.log. */
    if (Date.now() - last > 5000) {
      last = Date.now()
      log(`[update] ${line}`)
    }
  })
  if (!built.ok) {
    return {
      ok: false,
      message: `The build failed, so the installed Wumpy was left as it was. The end of it:\n\n\`\`\`\n${tail(built.out, 10)}\n\`\`\``
    }
  }
  log('[update] installed')
  return { ok: true, message: 'Installed.' }
}
