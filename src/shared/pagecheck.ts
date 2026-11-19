/**
 * What a headless browser's log says went wrong on a page. See
 * main/pagecheck.ts. Pure, so it can be checked against real log lines.
 *
 * Chromium logs every console message at INFO, errors included, as
 *   [..:INFO:CONSOLE:142] "Uncaught ReferenceError: car is not defined", source: file:///.../x.html (142)
 * so the level is no help: the message is. An uncaught exception says
 * "Uncaught"; console.error output and failed loads say "Error" or
 * "Failed". Ordinary console.log lines are left out.
 */
const LINE = /CONSOLE[^\]]*\]\s*"([\s\S]*?)",\s*source:\s*(\S*)\s*\((\d+)\)/g

export function pageErrors(log: string, max = 8): string[] {
  const out: string[] = []
  for (const m of log.matchAll(LINE)) {
    const message = m[1].trim()
    if (!/^Uncaught\b|\bError\b|\bFailed\b|is not defined|is not a function|Cannot read propert/i.test(message)) continue
    const line = Number(m[3])
    const said = `${message}${line > 0 ? ` (line ${line})` : ''}`
    if (!out.includes(said)) out.push(said)
    if (out.length >= max) break
  }
  return out
}

/**
 * The play test. The page's `player` (or `chicken`, `frog`, `hero`, the head
 * of its `snake`, its `pacman`... - whatever it is called) and `score` are
 * read, the arrow keys are held one after another, and they are read again.
 * A game whose player never moved for its keys is the most common way a
 * written game fails: a Crossy Road came back where each hop took eight
 * seconds and never landed, with a clean console. Only plain numbers and
 * flags are kept. Run by main in a hidden window (main/pagecheck.ts); these
 * are the scripts it runs there.
 *
 * And whether the game is over - by its flag (`gameOver`, `state.over`,
 * `player.alive`...), by "GAME OVER" on the page, or drawn on the canvas,
 * which HOOK_JS listens for - and a fingerprint of what the canvas shows,
 * so a game that froze shows as one: a Snake came back whose Play Again
 * button hid the message and left the snake standing for ever, its loop
 * stopped at the game over and never started again.
 */
export const HOOK_JS = `(() => {
  if (window.__wumpy) return true
  const w = (window.__wumpy = { texts: [] })
  const P = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype
  if (P) for (const m of ['fillText', 'strokeText']) {
    const orig = P[m]
    P[m] = function (t, ...a) { if (w.texts.length < 400) w.texts.push(String(t)); return orig.call(this, t, ...a) }
  }
  return true
})()`

export const LOOK_JS = `(() => {
  const pick = (v) => {
    if (v === null || typeof v !== 'object') return typeof v === 'number' || typeof v === 'boolean' ? v : undefined
    const out = {}
    for (const k in v) { const x = v[k]; if (typeof x === 'number') out[k] = Math.round(x * 100) / 100; else if (typeof x === 'boolean') out[k] = x }
    return out
  }
  const seen = {}
  const names = ['player', 'chicken', 'frog', 'hero', 'character', 'avatar', 'me', 'pacman', 'pacMan', 'pac', 'ship', 'bird']
  const get = (name) => { try { return (0, eval)('typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined') } catch (e) { return undefined } }
  /* A snake is its head: an array of cells, or an object holding one. */
  const head = (v) => {
    const cells = Array.isArray(v) ? v : v && typeof v === 'object' ? v.body || v.segments || v.cells || v.parts : null
    if (!Array.isArray(cells) || !cells.length) return undefined
    const h = cells[0]
    if (Array.isArray(h) && typeof h[0] === 'number') return { x: h[0], y: h[1], length: cells.length }
    if (h && typeof h === 'object' && typeof h.x === 'number') return { x: h.x, y: h.y, length: cells.length }
    return undefined
  }
  for (const name of names) { const v = get(name); if (v && typeof v === 'object') { seen.player = pick(v); break } }
  if (!seen.player) { const h = head(get('snake')); if (h) seen.player = h }
  const boxes = ['state', 'game', 'world', 'gameState', 'G']
  /* Or one level down, in the object a game keeps its state in. */
  for (const box of boxes) {
    if (seen.player) break
    const b = get(box)
    if (!b || typeof b !== 'object') continue
    for (const name of names) { const v = b[name]; if (v && typeof v === 'object') { seen.player = pick(v); break } }
    if (!seen.player) { const h = head(b.snake); if (h) seen.player = h }
    /* Or flat in it: playerX, playerY, chickenRow. */
    if (!seen.player) {
      const flat = {}
      for (const k in b) if (/^(?:player|chicken|frog|hero|pacman|pac)(?:x|y|row|col)$/i.test(k) && typeof b[k] === 'number') flat[k] = b[k]
      if (Object.keys(flat).length) seen.player = flat
    }
    if (seen.score === undefined && typeof b.score === 'number') seen.score = b.score
  }
  if (seen.score === undefined) seen.score = pick(get('score'))
  /* Over, by the game's own flag first. */
  let over
  for (const n of ['gameOver', 'isGameOver', 'gameover', 'game_over', 'dead', 'isDead']) { const v = get(n); if (typeof v === 'boolean') { over = v; break } }
  for (const box of boxes) {
    if (over !== undefined) break
    const b = get(box)
    if (typeof b === 'string' && b.length < 30) { over = /over|dead|lost|end|crash/i.test(b); break }
    if (!b || typeof b !== 'object') continue
    for (const n of ['gameOver', 'over', 'isGameOver', 'gameover', 'dead', 'isOver']) if (typeof b[n] === 'boolean') { over = b[n]; break }
    if (over === undefined && typeof b.state === 'string' && b.state.length < 30) over = /over|dead|lost|end|crash/i.test(b.state)
    if (over === undefined && typeof b.status === 'string' && b.status.length < 30) over = /over|dead|lost|end|crash/i.test(b.status)
  }
  if (over === undefined && seen.player && typeof seen.player.alive === 'boolean') over = !seen.player.alive
  if (over === undefined && seen.player && typeof seen.player.dead === 'boolean') over = seen.player.dead
  const OVER = /^\\W*(game\\s*over|you\\s+(died|lose|lost|crashed|were hit)|crashed|splat|wasted)\\b/i
  /* Or by what the page says, short and on screen. */
  if (over === undefined) {
    for (const e of document.querySelectorAll('body *')) {
      const t = (e.children.length ? '' : e.textContent || '').trim()
      if (!t || t.length > 40 || !OVER.test(t)) continue
      const cs = getComputedStyle(e)
      if (e.getClientRects().length && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05) { over = true; break }
    }
  }
  /* Or by what it drew on the canvas since the last look. */
  const w = window.__wumpy
  const texts = w ? w.texts.splice(0) : []
  if (texts.length) seen.drawn = [...new Set(texts)].join(' | ').slice(0, 200)
  if (over === undefined && texts.some((t) => OVER.test(t))) over = true
  seen.over = over === true
  seen.overKnown = over !== undefined
  /* Where its ghosts, cars, aliens are: a Pac-Man came back whose ghosts
     never left their pen. */
  const crowd = {}
  for (const n of ['ghosts', 'enemies', 'cars', 'vehicles', 'logs', 'obstacles', 'aliens', 'invaders', 'asteroids', 'pipes', 'monsters', 'zombies']) {
    let v = get(n)
    if (!Array.isArray(v)) for (const box of boxes) { const b = get(box); if (b && typeof b === 'object' && Array.isArray(b[n])) { v = b[n]; break } }
    if (!Array.isArray(v) || !v.length) continue
    const pts = []
    for (const o of v.slice(0, 12)) {
      if (!o || typeof o !== 'object') continue
      const x = typeof o.x === 'number' ? o.x : typeof o.col === 'number' ? o.col : o.pos && o.pos.x
      const y = typeof o.y === 'number' ? o.y : typeof o.row === 'number' ? o.row : o.pos && o.pos.y
      if (typeof x === 'number' && typeof y === 'number') pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10])
    }
    if (pts.length) crowd[n] = pts
  }
  seen.crowd = crowd
  seen.t = performance.now()
  const cv = document.querySelector('canvas')
  if (cv) seen.width = cv.width
  /* What the canvas shows, as a number: the same number twice, nothing moved. */
  const c = document.querySelector('canvas')
  let h = 0
  try {
    const x = c && c.width && c.height ? c.getContext('2d') : null
    if (x) { const d = x.getImageData(0, 0, c.width, c.height).data; const step = Math.max(4, Math.floor(d.length / 40000) * 4 + 1); for (let i = 0; i < d.length; i += step) h = (h * 31 + d[i]) | 0 }
    else { const s = document.body ? document.body.innerHTML : ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0 }
  } catch (e) { h = 0 }
  seen.frame = h
  return seen
})()`

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  R: { key: 'r', code: 'KeyR', keyCode: 82 }
}

/**
 * One key event, at the focused element: it bubbles to the document and the
 * window. Sent to both, every press counted twice. Down and up are separate
 * so a key can be held: a game that moves while a key is down saw it down
 * for no frames at all when the two came together.
 */
export function keyJs(name: string, type: 'keydown' | 'keyup'): string {
  const k = KEYS[name] ?? { key: name, code: name, keyCode: 0 }
  return `(() => { const o = { key: ${JSON.stringify(k.key)}, code: '${k.code}', keyCode: ${k.keyCode}, which: ${k.keyCode}, bubbles: true, cancelable: true }; const t = document.activeElement || document.body || document; t.dispatchEvent(new KeyboardEvent('${type}', o)); return true })()`
}

/** A press, down then straight up: what the old play test sent. */
export function pressJs(key: string): string {
  return `(() => { ${keyJs(key, 'keydown')}; ${keyJs(key, 'keyup')}; return true })()`
}

/**
 * Clicks the page's own restart or start button, if it shows one; else the
 * middle of its canvas. Returns what it clicked.
 */
export const CLICK_JS = `(() => {
  const words = /again|restart|retry|new game|play|start|try/i
  for (const e of document.querySelectorAll('button, [role=button], a, input[type=button], .btn, .button')) {
    const t = (e.textContent || e.value || '').trim()
    if (!t || t.length > 30 || !words.test(t) || !e.getClientRects().length) continue
    const cs = getComputedStyle(e)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue
    e.click()
    return 'its "' + t + '" button'
  }
  const c = document.querySelector('canvas')
  if (!c) return ''
  const r = c.getBoundingClientRect()
  const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  for (const type of ['mousedown', 'mouseup', 'click']) c.dispatchEvent(new MouseEvent(type, o))
  return 'a click on its canvas'
})()`

export type Seen = {
  player?: Record<string, number | boolean>
  score?: unknown
  over?: boolean
  overKnown?: boolean
  frame?: number
  drawn?: string
  crowd?: Record<string, Array<[number, number]>>
  /** The page's own clock at the look, in milliseconds. */
  t?: number
  /** Its canvas's width, when it has one. */
  width?: number
} | null

/**
 * What never got anywhere, over looks a few seconds apart: "ghosts" when no
 * ghost was ever more than 32 pixels - or two tiles, for a game whose
 * coordinates stay under 64 - from where it was at the first look. Ghosts shut in their pen
 * bob up and down in it; that is not moving.
 */
export function stuckCrowds(looks: readonly Seen[]): string[] {
  const out: string[] = []
  const first = looks[0]?.crowd ?? {}
  for (const [name, a] of Object.entries(first)) {
    const later = looks.slice(1).map((l) => l?.crowd?.[name]).filter((b): b is Array<[number, number]> => Boolean(b) && b!.length === a.length)
    if (!later.length) continue
    /* Counted in tiles when no coordinate gets past 64: a Crossy Road's
       cars at x 5.9 drove a tile every third of a second. */
    const tiles = [a, ...later].every((pts) => pts.every(([x, y]) => Math.abs(x) < 64 && Math.abs(y) < 64))
    const far = tiles ? 2 : 32
    if (later.every((b) => a.every(([x, y], i) => Math.abs(x - b[i][0]) < far && Math.abs(y - b[i][1]) < far))) out.push(name)
  }
  return out
}

/**
 * How fast its ghosts, cars, aliens go, from two looks a moment apart:
 * the ones that go faster than anyone could play against. The commonest
 * bug in a written game is a speed added once a frame, or a time in
 * milliseconds used as seconds - a Crossy Road's cars crossed the road in
 * well under a second, at a dozen times the speed it meant.
 */
export function tooFast(a: Seen, b: Seen): Array<{ name: string; speed: number; tiles: boolean }> {
  const seconds = ((b?.t ?? 0) - (a?.t ?? 0)) / 1000
  if (!(seconds > 0.03)) return []
  const out: Array<{ name: string; speed: number; tiles: boolean }> = []
  const every = [...Object.values(a?.crowd ?? {}), ...Object.values(b?.crowd ?? {})].flat()
  const tiles = every.every(([x, y]) => Math.abs(x) < 64 && Math.abs(y) < 64)
  const xs = every.map(([x]) => x)
  const extent = xs.length ? Math.max(...xs) - Math.min(...xs) : 0
  /* Faster than across the screen in a second or so: six tiles, or the
     canvas's width (400 pixels at least). */
  const limit = tiles ? 6 : Math.max(400, (b?.width ?? 0) * 0.8)
  for (const [name, p] of Object.entries(a?.crowd ?? {})) {
    const q = b?.crowd?.[name]
    if (!q || q.length !== p.length) continue
    /* A jump of most of the way across is one going off one side and
       coming back on the other, not speed. */
    const speeds = p
      .map(([x, y], i) => Math.max(Math.abs(q[i][0] - x), Math.abs(q[i][1] - y)))
      .filter((d) => d < Math.max(extent * 0.6, tiles ? 5 : 200))
      .map((d) => d / seconds)
      .sort((m, n) => m - n)
    if (!speeds.length) continue
    const median = speeds[Math.floor(speeds.length / 2)]
    if (median > limit) out.push({ name, speed: Math.round(median), tiles })
  }
  return out
}

const KEY_NAMES: Record<string, string> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** Whether the player moved: by where it IS, not where it is headed. */
export function playFrom(before: Seen, after: Seen, key = 'ArrowUp'): { moved: boolean | null; line: string } {
  const b = before?.player
  const a = after?.player
  if (!b || !a) return { moved: null, line: '' }
  /* A hop that set `targetRow` and never landed left `row` where it was.
     Any number counts only when there is no position-like field at all. */
  const POSITION = /^(?:player|chicken|frog|hero|pacman|pac)?(?:x|y|row|col|column|lane|tx|ty|gx|gy|px|py|tilex|tiley|gridx|gridy|posx|posy|cellx|celly)$/i
  const watched = Object.keys(b).filter((k) => typeof b[k] === 'number')
  const where = watched.filter((k) => POSITION.test(k))
  const changed = (where.length ? where : watched).filter((k) => b[k] !== a[k])
  const said = (o: Record<string, number | boolean>): string =>
    Object.entries(o)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
  const name = KEY_NAMES[key] ?? key
  return changed.length
    ? { moved: true, line: `Holding the ${name} arrow three times moved the player: ${said(b)} became ${said(a)}.` }
    : { moved: false, line: `Holding the ${name} arrow three times did not move the player at all: it stayed ${said(b)}.` }
}

/**
 * The lines an error points at, quoted from the file: "line 134" alone sent
 * the chat off to read the file with a picture viewer, and then guessing.
 * Up to three places, three lines either side, the line itself marked.
 */
export function excerpts(source: string, errors: readonly string[], around = 3): string {
  const lines = source.split(/\r?\n/)
  const wanted: number[] = []
  for (const e of errors) {
    const m = /\bline (\d+)/i.exec(e)
    const n = m ? Number(m[1]) : 0
    if (n >= 1 && n <= lines.length && !wanted.some((w) => Math.abs(w - n) <= around)) wanted.push(n)
    if (wanted.length >= 3) break
  }
  return wanted
    .map((n) => {
      const from = Math.max(1, n - around)
      const to = Math.min(lines.length, n + around)
      const width = String(to).length
      const shown = []
      for (let i = from; i <= to; i++) shown.push(`${i === n ? '>' : ' '}${String(i).padStart(width)} | ${lines[i - 1].slice(0, 200)}`)
      return `Line ${n}:\n${shown.join('\n')}`
    })
    .join('\n\n')
}

/** The hand-back: what Wumpy found, said to be from the app. */
export function pageErrorText(path: string, errors: readonly string[], context = ''): string {
  return [
    `Wumpy loaded ${path} out of sight to check it, and its console showed:`,
    ...errors.map((e) => `- ${e}`),
    ...(context ? ['', 'Where, in the file as written:', context] : []),
    '',
    'That is a bug in the page you wrote. Find the cause in the code - the file is what you wrote above; a command reads it if you need it again, never a picture tool - fix it and anything else wrong you see on the way, and write the whole file again. Do not tell the user it works until it loads clean and its player moves. This was sent by Wumpy, not typed by the user.'
  ].join('\n')
}

/** How many times one request may be sent back for errors before a person decides. */
export const PAGE_ROUNDS = 2
