import { BrowserWindow, session } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOK_JS, playFrom, pressJs } from '@shared/pagecheck'

/**
 * Loads a web page Wumpy just wrote, out of sight, and reports what broke.
 *
 * "create a html file in my downloads folder that opens a page where i can
 * play a basic retro crossy road" was written, said to work - "open that file
 * and you play it with the arrow keys" - and crashed on its first frame:
 * `car` was not defined in the log-drawing loop. The model then guessed the
 * window needed focus. One load prints the error in a second: "Uncaught
 * ReferenceError: car is not defined". So the app does that load itself
 * after writing any .html file, presses the up arrow to see whether its
 * player moves, and hands what it found to the model.
 *
 * In a window of Wumpy's own, never shown: Chromium already, the same on
 * Windows and Linux, nothing to find or install. A headless browser on the
 * command line was tried first, and with a game loop running it printed
 * its findings on some runs and hung on others. This window is sandboxed,
 * has no Node, no preload and no network - only the page's own files - in
 * a session kept in memory, and is destroyed when the check is done.
 */
export interface PageCheck {
  /** Whether the page was loaded at all. */
  checked: boolean
  /** "Uncaught ReferenceError: car is not defined (line 142)". */
  errors: string[]
  /** What pressing the up arrow did to its `player`, when it has one. */
  play?: { moved: boolean; line: string }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let fenced = false
/** The session the checks run in: in memory, and walled off from the network. */
function checkSession(): Electron.Session {
  const s = session.fromPartition('wumpy-pagecheck')
  if (!fenced) {
    fenced = true
    s.webRequest.onBeforeRequest((details, done) => {
      const local = /^(?:file|data|blob|devtools):/i.test(details.url)
      done({ cancel: !local })
    })
    s.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  }
  return s
}

export async function checkPage(path: string): Promise<PageCheck> {
  if (!/\.html?$/i.test(path) || !existsSync(path)) return { checked: false, errors: [] }
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1000,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: checkSession(),
      /* A hidden window's timers and frames would otherwise be slowed or
         stopped, and a game loop with them. */
      backgroundThrottling: false
    }
  })
  const errors: string[] = []
  const contents = win.webContents
  contents.setFrameRate(30)
  contents.on('console-message', (details) => {
    if (details.level !== 'error') return
    if (details.sourceId && !details.sourceId.startsWith('file:')) return
    const said = `${details.message}${details.lineNumber ? ` (line ${details.lineNumber})` : ''}`
    if (!errors.includes(said) && errors.length < 8) errors.push(said)
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (e) => e.preventDefault())
  /* Never more than a few seconds a step: a page can hang its own thread. */
  const run = async (js: string): Promise<unknown> =>
    Promise.race([contents.executeJavaScript(js, true).catch(() => null), sleep(2500).then(() => null)])
  try {
    const loaded = await Promise.race([win.loadFile(path).then(() => true).catch(() => false), sleep(8000).then(() => false)])
    if (!loaded && contents.isDestroyed()) return { checked: false, errors: [] }
    await sleep(900)
    /*
     * A page that stops answering is the worst kind of broken: a Crossy
     * Road's lane builder looped for ever the moment the player stepped
     * up, freezing the tab. Asked something, it does not answer - so a
     * page that answered before the keys and not after them froze.
     */
    const alive = await run('1')
    if (alive === null) {
      errors.push('The page stopped responding as soon as it loaded: an endless loop, most likely.')
      return { checked: true, errors }
    }
    const before = (await run(LOOK_JS)) as Parameters<typeof playFrom>[0]
    for (let i = 0; i < 3; i++) {
      await run(pressJs('ArrowUp'))
      await sleep(350)
    }
    await sleep(1300)
    if ((await run('1')) === null) {
      errors.push('The page stopped responding after the up arrow was pressed: an endless loop, most likely, in what the key starts.')
      return { checked: true, errors }
    }
    const after = (await run(LOOK_JS)) as Parameters<typeof playFrom>[1]
    const play = playFrom(before, after)
    return { checked: true, errors, ...(play.moved === null ? {} : { play: { moved: play.moved, line: play.line } }) }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
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
    if (!result.checked) return { ran: false, ok: false, output: 'NOT RUN: the page could not be loaded.' }
    const play = result.play ? `\n${result.play.line}` : ''
    const stuck = result.play?.moved === false
    return result.errors.length || stuck
      ? {
          ran: true,
          ok: false,
          output: `Loaded it for 4 seconds.${result.errors.length ? ` Its console showed:\n${result.errors.map((e) => `- ${e}`).join('\n')}` : ' No errors in its console.'}${play}`
        }
      : { ran: true, ok: true, output: `Loaded it for 4 seconds: no errors in its console.${play} (That rules out crashes, not every wrong behaviour.)` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
