import { BrowserWindow, session } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLICK_JS, HOOK_JS, LOOK_JS, excerpts, keyJs, playFrom, stuckCrowds, tooFast, type Seen } from '@shared/pagecheck'

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
  /**
   * Losing, and starting again: what happened when the game was over and
   * Space, Enter, R and its button were tried. `ok` false is a bug - it did
   * not restart, or it restarted frozen.
   */
  restart?: { ok: boolean; line: string }
  /** Ghosts, cars, aliens that never moved while it was played. */
  stuck?: string
  /** What it looked like, mid-game: a PNG, for a model that can see. */
  shot?: Buffer
  /** And at game over, when it got there: a sideways game-over panel was
      on no screenshot the reviewer had. */
  overShot?: Buffer
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
    await run(HOOK_JS)
    const debug = process.env.WUMPY_PAGECHECK_DEBUG ? (what: string, v: unknown): void => console.log(`[pagecheck] ${what}: ${JSON.stringify(v)}`) : (): void => {}
    /*
     * What is on screen, as a number: the frame as drawn, not the canvas's
     * own pixels - read back in a hidden window, those came out all zeros,
     * and every game looked frozen.
     */
    const fingerprint = async (): Promise<number> => {
      try {
        const bits = (await contents.capturePage()).toBitmap()
        let h = 0
        for (let i = 0; i < bits.length; i += 397) h = (h * 31 + bits[i]) | 0
        return h
      } catch {
        return 0
      }
    }
    const look = async (): Promise<Seen> => {
      const seen = (await run(LOOK_JS)) as Seen
      if (seen) seen.frame = await fingerprint()
      debug('look', seen)
      return seen
    }
    const hold = async (key: string, ms = 180): Promise<void> => {
      await run(keyJs(key, 'keydown'))
      await sleep(ms)
      await run(keyJs(key, 'keyup'))
    }
    const frozen = async (when: string): Promise<boolean> => {
      if ((await run('1')) !== null) return false
      errors.push(`The page stopped responding ${when}: an endless loop, most likely, in what that starts.`)
      return true
    }

    /*
     * Moving. Up first - a Crossy Road's only way forward - then the other
     * arrows, as a Pac-Man facing a wall above it moves only sideways. A
     * game still on its title screen gets Space, Enter and a click, then
     * the arrows again. Only when none of it moves the player is that a bug.
     */
    let before = await look()
    let play: { moved: boolean; line: string } | undefined
    let lastKey = 'ArrowUp'
    let started = ''
    let startedBy = ''
    const tried: string[] = []
    const order = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'start', 'ArrowUp', 'ArrowLeft']
    for (let k = 0; k < order.length; k++) {
      const key = order[k]
      if (key === 'start') {
        /* Space and Enter first, looked at after each: a game that only a
           click on its button starts is said to be one. */
        const was = (await look())?.frame
        await hold('Space', 80)
        await sleep(300)
        const afterSpace = await look()
        if (afterSpace?.frame !== was) {
          started = 'Space'
        } else {
          await hold('Enter', 80)
          await sleep(300)
          const afterEnter = await look()
          started = afterEnter?.frame !== was ? 'Enter' : String((await run(CLICK_JS)) || 'a click')
        }
        startedBy = started
        await sleep(500)
        before = await look()
        continue
      }
      for (let i = 0; i < 3; i++) {
        await hold(key)
        await sleep(170)
      }
      await sleep(700)
      if (await frozen(`after the ${key.replace('Arrow', '').toLowerCase()} arrow was pressed`)) return { checked: true, errors }
      const after = await look()
      const p = playFrom(before, after, key)
      /* No player before the key, and one after: the key started the game.
         Its moves are measured from here. */
      if (p.moved === null && after?.player && !before?.player) {
        before = after
        continue
      }
      /* No player anywhere yet: a game that makes its player when it
         starts. Start it - Space, Enter, its button - before giving up:
         a Pac-Man threw the moment Space was pressed, and the test, having
         found nobody to move, had stopped before it pressed it. */
      if (p.moved === null && !started && k < order.indexOf('start')) {
        k = order.indexOf('start') - 1
        continue
      }
      if (p.moved === null) break
      tried.push(key.replace('Arrow', '').toLowerCase())
      lastKey = key
      play = { moved: p.moved, line: p.line }
      if (p.moved) break
      before = after
    }
    /* Moved, but only once its button was clicked: no key started it. A
       page that says "Press Space or Enter to start" and means it only of
       its button is broken: a Pac-Man looked its keys up in its arrow table
       first, and returned before Space was ever seen. */
    if (play?.moved && startedBy && !/^(?:Space|Enter)$/.test(startedBy)) {
      play = { moved: true, line: `${play.line} It only started after ${startedBy} was clicked: Space and Enter did nothing on its title screen.` }
      const promised = await run(`(document.body ? document.body.innerText : '') + ' ' + ((window.__wumpy && window.__wumpy.said) || '')`)
      if (/\b(?:press|hit|tap)\b[^.\n]{0,30}\b(?:space|enter|any key)\b/i.test(String(promised ?? ''))) {
        errors.push(`Its title screen says to press Space or Enter (or any key), but neither started it - only ${startedBy} did.`)
      }
    }
    if (play && !play.moved && tried.length > 1) {
      play = {
        moved: false,
        line: `${play.line.replace(/^Holding the \w+ arrow three times did not/, 'Holding each arrow key - ' + [...new Set(tried)].join(', ') + ' - three times did not')}${started ? ` Space, Enter and ${started} did not start it either.` : ''}`
      }
    }

    /*
     * Losing, then starting again. The game is played on - the last arrow
     * that moved it, again and again, into traffic or a wall - until it
     * says it is over, for six seconds at most. Then Space, Enter, R and
     * its restart button, in turn, until it is not over; then a second and
     * a half with the up arrow pressed, in which something must move.
     */
    let restart: { ok: boolean; line: string } | undefined
    /* How fast things go, from two looks a fifth of a second apart. */
    const quick = (await run(LOOK_JS)) as Seen
    await sleep(200)
    const quicker = (await run(LOOK_JS)) as Seen
    const fast = tooFast(quick, quicker)
    debug('speeds', { quick, quicker, fast })
    let state = await look()
    /* What it looks like a few seconds in, before anything is lost. */
    let shot: Buffer | undefined
    try {
      const image = await contents.capturePage()
      const size = image.getSize()
      shot = (size.width > 640 ? image.resize({ width: 640 }) : image).toPNG()
    } catch {
      shot = undefined
    }
    const crowdLooks: Seen[] = [state]
    const crowdAt = Date.now()
    const until = Date.now() + 6000
    while (state && !state.over && Date.now() < until) {
      await hold(lastKey, 60)
      await sleep(300)
      state = await look()
      crowdLooks.push(state)
    }
    if (await frozen('while the game was being played')) return { checked: true, errors }
    /* Ghosts or cars standing still for three seconds or more of play. */
    let stuck: string | undefined
    if (fast.length) {
      stuck = fast
        .map(
          (f) =>
            `Its ${f.name} move about ${f.speed} ${f.tiles ? 'tiles' : 'pixels'} a second - far faster than anyone can play against. Is a speed added every frame, or a time in milliseconds used as seconds?`
        )
        .join(' ')
    }
    const still = Date.now() - crowdAt >= 3000 ? stuckCrowds(crowdLooks) : []
    if (still.length) {
      stuck = `${stuck ? `${stuck} ` : ''}Its ${still.join(' and ')} never got anywhere in the ${Math.round((Date.now() - crowdAt) / 1000)} seconds it was played: none went more than a short way from where it was${still.includes('ghosts') ? ' - can they get out of their pen, and do they choose a way to go?' : '.'}`
    }
    let overShot: Buffer | undefined
    if (state?.over) {
      try {
        const image = await contents.capturePage()
        overShot = (image.getSize().width > 640 ? image.resize({ width: 640 }) : image).toPNG()
      } catch {
        overShot = undefined
      }
      let how = ''
      for (const [label, act] of [
        ['Space', () => hold('Space', 80)],
        ['Enter', () => hold('Enter', 80)],
        ['R', () => hold('R', 80)],
        ['button', () => run(CLICK_JS)]
      ] as Array<[string, () => Promise<unknown>]>) {
        const r = await act()
        /* Up to a second and a half for it to go: a game-over screen that
           fades out is still on its way out at the first look. */
        let s: Seen = null
        for (let wait = 0; wait < 5; wait++) {
          await sleep(300)
          s = await look()
          if (s && !s.over) break
        }
        if (s && !s.over) {
          how = label === 'button' ? String(r || 'a click') : label
          break
        }
      }
      if (!how) {
        restart = {
          ok: false,
          line: 'When the game was over, nothing started a new one: Space, Enter, R and its restart button were each tried, and it stayed over.'
        }
      } else {
        const r1 = await look()
        await sleep(300)
        await hold('ArrowUp')
        await sleep(1000)
        if (await frozen('after the game was restarted')) return { checked: true, errors }
        const r2 = await look()
        const moved = playFrom(r1, r2).moved
        const still = r1?.frame === r2?.frame && moved !== true
        restart = still
          ? {
              ok: false,
              line: `After game over, ${how} hid the message, but the game did not start again: for a second and a half, with the up arrow pressed, nothing on it moved. Is its loop stopped at game over and never started again?`
            }
          : { ok: true, line: `After game over, ${how} started a new game, and it runs.` }
      }
    }
    return {
      checked: true,
      errors,
      ...(play ? { play } : {}),
      ...(restart ? { restart } : {}),
      ...(stuck ? { stuck } : {}),
      ...(shot ? { shot } : {}),
      ...(overShot ? { overShot } : {})
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * A page that is only text so far - a background agent's, before anything is
 * saved - loaded the same way from a temporary file, which is then removed.
 * Said as the agent should read it.
 */
export async function checkHtml(html: string): Promise<{ ran: boolean; ok: boolean; output: string; shots?: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-page-'))
  const file = join(dir, 'page.html')
  try {
    writeFileSync(file, html)
    const result = await checkPage(file)
    if (!result.checked) return { ran: false, ok: false, output: 'NOT RUN: the page could not be loaded.' }
    const pictures = [result.shot, result.overShot].filter((b): b is Buffer => Boolean(b)).map((b) => `data:image/png;base64,${b.toString('base64')}`)
    const shot = pictures.length ? { shots: pictures } : {}
    const play = `${result.play ? `\n${result.play.line}` : ''}${result.restart ? `\n${result.restart.line}` : ''}${result.stuck ? `\n${result.stuck}` : ''}`
    const stuck = result.play?.moved === false || result.restart?.ok === false || Boolean(result.stuck)
    return result.errors.length || stuck
      ? {
          ran: true,
          ok: false,
          ...shot,
          output: `Loaded it and played it.${result.errors.length ? ` Its console showed:\n${result.errors.map((e) => `- ${e}`).join('\n')}${excerpts(html, result.errors) ? `\n\nWhere, in your page:\n${excerpts(html, result.errors)}` : ''}` : ' No errors in its console.'}${play}`
        }
      : { ran: true, ok: true, ...shot, output: `Loaded it and played it: no errors in its console.${play} (That rules out crashes and a dead start, not every wrong behaviour.)` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A page played the way an agent asks, and the values it asks about read
 * back: a debugger for a game it cannot see. "Holding each arrow did not
 * move the player" sent Pac-Man agents rewriting their movement code blind,
 * version after version; asked to look first - where is Pac-Man, what does
 * canMove say - the cause is a line or two away.
 *
 *   press: Space, ArrowLeft, ArrowLeft
 *   wait: 800
 *   show: pacman
 *   show: canMove(pacman.tx, pacman.ty, 'left')
 */
export async function probePage(html: string, script: string): Promise<{ ran: boolean; ok: boolean; output: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-probe-'))
  const file = join(dir, 'page.html')
  writeFileSync(file, html)
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1000,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: checkSession(), backgroundThrottling: false }
  })
  const contents = win.webContents
  contents.setFrameRate(30)
  const errors: string[] = []
  contents.on('console-message', (details) => {
    if (details.level !== 'error') return
    const said = `${details.message}${details.lineNumber ? ` (line ${details.lineNumber})` : ''}`
    if (!errors.includes(said) && errors.length < 6) errors.push(said)
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (e) => e.preventDefault())
  const run = async (js: string): Promise<unknown> =>
    Promise.race([contents.executeJavaScript(js, true).catch((e: Error) => `Error: ${e.message}`), sleep(2500).then(() => 'TIMED OUT: the page stopped answering')])
  const out: string[] = []
  try {
    const loaded = await Promise.race([win.loadFile(file).then(() => true).catch(() => false), sleep(8000).then(() => false)])
    if (!loaded) return { ran: false, ok: false, output: 'NOT RUN: the page did not load.' }
    await sleep(700)
    for (const raw of script.split('\n').slice(0, 30)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = /^(press|wait|show)\s*:\s*(.+)$/i.exec(line)
      if (!m) {
        out.push(`? ${line} - not understood: use press:, wait: or show:`)
        continue
      }
      const what = m[2].trim()
      if (m[1].toLowerCase() === 'press') {
        for (const key of what.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 12)) {
          const name = key === ' ' || /^space$/i.test(key) ? 'Space' : /^enter$/i.test(key) ? 'Enter' : key
          await run(keyJs(name, 'keydown'))
          await sleep(180)
          await run(keyJs(name, 'keyup'))
          await sleep(150)
        }
        out.push(`pressed ${what}`)
      } else if (m[1].toLowerCase() === 'wait') {
        const ms = Math.min(5000, Math.max(0, Number(what) || 0))
        await sleep(ms)
        out.push(`waited ${ms}ms`)
      } else {
        const value = await run(`(() => { try { const v = (0, eval)(${JSON.stringify(`(${what})`)}); const s = JSON.stringify(v, (k, x) => typeof x === 'number' ? Math.round(x * 100) / 100 : x); return s === undefined ? String(v) : s.slice(0, 900) } catch (e) { return 'Error: ' + e.message } })()`)
        out.push(`${what} = ${String(value)}`)
      }
    }
    if (errors.length) out.push(`Its console showed:\n${errors.map((e) => `- ${e}`).join('\n')}`)
    return { ran: true, ok: true, output: out.join('\n') }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}
