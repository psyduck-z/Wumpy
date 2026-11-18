import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pageErrors } from '@shared/pagecheck'

/**
 * Loads a web page Wumpy just wrote, out of sight, and reports what broke.
 *
 * "create a html file in my downloads folder that opens a page where i can
 * play a basic retro crossy road" was written, said to work - "open that file
 * and you play it with the arrow keys" - and crashed on its first frame:
 * `car` was not defined in the log-drawing loop. The model then guessed the
 * window needed focus. One headless load prints the error in a second:
 * "Uncaught ReferenceError: car is not defined". So the app does that load
 * itself after writing any .html file, and hands the errors to the model.
 *
 * A Chromium-family browser, which every Windows machine has as Edge, with a
 * throwaway profile so nothing of the user's is opened, touched or locked.
 * Three seconds of the page's own time, then it is closed.
 */
export interface PageCheck {
  /** Whether a browser was found and the page was loaded at all. */
  checked: boolean
  /** "Uncaught ReferenceError: car is not defined (line 142)". */
  errors: string[]
  browser?: string
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const full = join(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

/** A Chromium-family browser that can run headless, or null. */
export function headlessBrowser(): string | null {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[]
    for (const root of roots) {
      for (const rel of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
        const full = join(root, rel)
        if (existsSync(full)) return full
      }
    }
    return null
  }
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
      if (existsSync(app)) return app
    }
    return null
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave', 'microsoft-edge']) {
    const found = onPath(name)
    if (found) return found
  }
  return null
}

export function checkPage(path: string): Promise<PageCheck> {
  if (!/\.html?$/i.test(path)) return Promise.resolve({ checked: false, errors: [] })
  const browser = headlessBrowser()
  if (!browser) return Promise.resolve({ checked: false, errors: [] })
  const profile = mkdtempSync(join(tmpdir(), 'wumpy-pagecheck-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    '--enable-logging=stderr',
    '--v=0',
    '--virtual-time-budget=3000',
    '--dump-dom',
    pathToFileURL(path).href
  ]
  return new Promise((resolve) => {
    let stderr = ''
    let done = false
    const finish = (checked: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        /* a locked file in a temporary folder is not worth an error */
      }
      resolve({ checked, errors: checked ? pageErrors(stderr) : [], browser })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(browser, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch {
      finish(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(true)
    }, 20_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString()
    })
    child.on('error', () => finish(false))
    child.on('close', () => finish(true))
  })
}

/**
 * A page that is only text so far - a background agent's, before anything is
 * saved - loaded the same way from a temporary file, which is then removed.
 * Said as the agent should read it.
 */
export async function checkHtml(html: string): Promise<{ ran: boolean; ok: boolean; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-page-'))
  const file = join(dir, 'page.html')
  try {
    writeFileSync(file, html)
    const result = await checkPage(file)
    if (!result.checked) return { ran: false, ok: false, output: 'NOT RUN: no browser here can load a page out of sight.' }
    return result.errors.length
      ? { ran: true, ok: false, output: `Loaded it for 3 seconds. Its console showed:\n${result.errors.map((e) => `- ${e}`).join('\n')}` }
      : { ran: true, ok: true, output: 'Loaded it for 3 seconds: no errors in its console. (That rules out crashes, not wrong behaviour.)' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
