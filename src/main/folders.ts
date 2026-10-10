/**
 * Where this user's folders actually are.
 *
 * Documents, Pictures and Desktop are redirected to OneDrive on a great many
 * Windows machines, including the one this was written on, so
 * `%USERPROFILE%\Documents` does not exist there. The model guessed it
 * anyway, and the result is the worst available failure: asked for the
 * biggest files in Documents, `Get-ChildItem "$env:USERPROFILE\Documents"`
 * returned an empty stdout AND an empty stderr. Nothing to read, nothing to
 * diagnose - "you have no files" and "I looked in the wrong place" are the
 * same output.
 *
 * Telling the model the rule was not enough on its own: it followed it for
 * Pictures and ignored it for Documents on the next question. So the paths go
 * into the facts block instead, where they are a thing it has been told
 * rather than a thing it has to remember to work out.
 *
 * Resolved once, by asking Windows the same way the prompt recommends -
 * [Environment]::GetFolderPath - because the registry is the only authority
 * on this and a redirect can point anywhere, not just at OneDrive.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type UserFolders = {
  documents: string
  pictures: string
  desktop: string
  downloads: string
}

let cached: UserFolders | null = null

/**
 * Downloads is the exception twice over: it is usually NOT redirected, and it
 * has no SpecialFolder name at all, so the profile path is the right answer
 * there. The other three have names and must be asked for.
 */
const LOOKUPS: Array<[keyof UserFolders, string]> = [
  ['documents', 'MyDocuments'],
  ['pictures', 'MyPictures'],
  ['desktop', 'Desktop']
]

/**
 * A best guess with no subprocess, used until the real answer lands and if
 * the lookup ever fails.
 *
 * Only ever returns a folder that exists, so a wrong guess becomes a missing
 * fact rather than a confident lie - which is the whole failure being fixed.
 */
function guess(): UserFolders {
  const home = homedir()
  const oneDrive = process.env.OneDrive ?? process.env.OneDriveConsumer ?? join(home, 'OneDrive')
  const pick = (name: string): string => {
    for (const base of [oneDrive, home]) {
      const path = join(base, name)
      if (existsSync(path)) return path
    }
    return ''
  }
  return {
    documents: pick('Documents'),
    pictures: pick('Pictures'),
    desktop: pick('Desktop'),
    downloads: existsSync(join(home, 'Downloads')) ? join(home, 'Downloads') : ''
  }
}

/** Whatever is known now. Never blocks; may be the guess. */
export function userFolders(): UserFolders {
  return cached ?? guess()
}

/**
 * Asks Windows, once, and caches the answer.
 *
 * Failure is not an error worth surfacing: the guess above is already
 * correct on an ordinary machine, and a folder that cannot be resolved is
 * simply left out of the facts rather than stated wrongly.
 */
export function resolveUserFolders(): Promise<UserFolders> {
  if (cached) return Promise.resolve(cached)

  const script = LOOKUPS.map(([, name]) => `[Environment]::GetFolderPath("${name}")`).join('; ')

  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value: UserFolders): void => {
      if (done) return
      done = true
      cached = value
      resolve(value)
    }

    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true }
      )
      child.stdout.on('data', (d) => (out += d))
      child.on('error', () => finish(guess()))
      child.on('close', () => {
        const lines = out
          .split(String.fromCharCode(10))
          .map((l) => l.trim())
          .filter(Boolean)
        const fallback = guess()
        const result = { ...fallback }
        LOOKUPS.forEach(([key], i) => {
          const path = lines[i]
          // A path is only taken if it is really there. GetFolderPath
          // happily returns a folder that has never been created.
          if (path && existsSync(path)) result[key] = path
        })
        finish(result)
      })
      setTimeout(() => finish(guess()), 5000)
    } catch {
      finish(guess())
    }
  })
}

/**
 * The facts-block lines, or none.
 *
 * Only says what is true: a folder that could not be resolved is omitted,
 * and the OneDrive note is added only when something really is redirected -
 * on a machine where it is not, the line would be a distraction that
 * invites the model to go looking for a path that is not there.
 */
export function folderFacts(folders: UserFolders = userFolders()): string[] {
  const home = homedir()
  const named: Array<[string, string]> = [
    ['Documents', folders.documents],
    ['Pictures', folders.pictures],
    ['Desktop', folders.desktop],
    ['Downloads', folders.downloads]
  ]
  const known = named.filter(([, path]) => Boolean(path))
  if (known.length === 0) return []

  const redirected = known.filter(([name, path]) => path !== join(home, name))
  const lines = known.map(([name, path]) => `  ${name}: ${path}`)
  return [
    redirected.length
      ? '- Their real folders, already resolved. Use these paths exactly; do not build' +
        ' them from $env:USERPROFILE, because some are redirected and the guessed path' +
        ' does not exist:'
      : '- Their folders:',
    ...lines
  ]
}
