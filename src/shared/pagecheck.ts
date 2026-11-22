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
  const w = (window.__wumpy = { texts: [], said: '' })
  const P = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype
  if (P) for (const m of ['fillText', 'strokeText']) {
    const orig = P[m]
    P[m] = function (t, ...a) { if (w.texts.length < 400) w.texts.push(String(t)); if (w.said.length < 4000) w.said += ' ' + String(t); return orig.call(this, t, ...a) }
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
  let me
  for (const name of names) { const v = get(name); if (v && typeof v === 'object') { seen.player = pick(v); me = v; break } }
  if (!seen.player) { const h = head(get('snake')); if (h) seen.player = h }
  const boxes = ['state', 'game', 'world', 'gameState', 'G']
  /* Or one level down, in the object a game keeps its state in. */
  for (const box of boxes) {
    if (seen.player) break
    const b = get(box)
    if (!b || typeof b !== 'object') continue
    for (const name of names) { const v = b[name]; if (v && typeof v === 'object') { seen.player = pick(v); me = v; break } }
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
      /* Shown, counting its parents: an overlay faded out by its parent's
         opacity is not on screen. */
      const shown = e.checkVisibility ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) : (e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && Number(getComputedStyle(e).opacity) > 0.05)
      if (shown) { over = true; break }
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
  /* What can hit the player, where it can: in the arrays above, or in its
     lanes, which is where a Crossy Road keeps its cars - with the lane's
     y. Logs and lily pads carry it; they are left out. */
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined)
  const harm = []
  const safe = /log|turtle|lily|pad|coin|plank|boat|raft|platform|player|chicken|frog|hero|tree|rock|bush|grass|pickup|gem|power|bonus/i
  /* Once each: a car kept in cars and in its lane's list as well was
     counted twice, and two of it in one place read as cars stacked. */
  const added = new Set()
  const add = (o, ly) => {
    if (!o || typeof o !== 'object' || o === me || added.has(o) || safe.test(String(o.type || o.kind || o.name || ''))) return
    added.add(o)
    const x = num(o.x) ?? num(o.col) ?? (o.pos ? num(o.pos.x) : undefined)
    const y = num(o.y) ?? num(o.row) ?? (o.pos ? num(o.pos.y) : undefined) ?? ly
    if (x === undefined || y === undefined) return
    harm.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, num(o.w) ?? num(o.width) ?? num(o.len) ?? num(o.length) ?? 0])
  }
  const arrayOf = (n) => {
    const v = get(n)
    if (Array.isArray(v)) return v
    for (const box of boxes) { const b = get(box); if (b && typeof b === 'object' && Array.isArray(b[n])) return b[n] }
    return null
  }
  for (const n of ['cars', 'vehicles', 'trucks', 'enemies', 'obstacles', 'aliens', 'asteroids', 'monsters', 'zombies', 'entities', 'movers', 'traffic']) {
    const v = arrayOf(n)
    if (v) for (const o of v.slice(0, 60)) add(o)
  }
  for (const n of ['lanes', 'rows', 'roads', 'lines', 'strips']) {
    const v = arrayOf(n)
    if (!v) continue
    for (const [i, lane] of v.slice(0, 80).entries()) {
      if (!lane || typeof lane !== 'object' || /water|river|lake|sea|log/i.test(String(lane.type || lane.kind || ''))) continue
      /* A lane with no y of its own is the row it is in the list. */
      const ly = num(lane.y) ?? num(lane.row) ?? num(lane.index) ?? i
      for (const k of ['cars', 'vehicles', 'entities', 'objects', 'objs', 'obstacles', 'items', 'movers', 'things', 'list'])
        if (Array.isArray(lane[k])) for (const o of lane[k].slice(0, 20)) add(o, ly)
    }
  }
  if (harm.length) seen.harm = harm.slice(0, 120)
  /* How big a tile is, where it says. */
  for (const n of ['TILE', 'TILE_SIZE', 'CELL', 'CELL_SIZE', 'GRID', 'GRID_SIZE', 'TS', 'BLOCK', 'SIZE']) { const t = num(get(n)); if (t && t >= 8 && t <= 200) { seen.tile = t; break } }
  /* Lives, wherever it keeps them: one lost is a death. */
  let lives = num(get('lives'))
  for (const box of boxes) { if (lives !== undefined) break; const b = get(box); if (b && typeof b === 'object') lives = num(b.lives) }
  if (lives === undefined && seen.player) lives = num(seen.player.lives)
  if (lives !== undefined) seen.lives = lives
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
  /** What can hit the player: [x, y, width], the lane's y for a car kept in a lane. */
  harm?: Array<[number, number, number]>
  lives?: number
  /** Pixels per tile, from a TILE or GRID_SIZE the page keeps. */
  tile?: number
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
 * The ones left behind: members of a crowd that never moved while the rest
 * did. A maze game's fourth chaser started inside the solid block in the
 * middle and never left it, while the other three roamed - and "never got
 * anywhere" is only said of a crowd that all stood still. Each as
 * { name, which } (1-based), in the same looks and units as stuckCrowds.
 */
export function leftBehind(looks: readonly Seen[]): Array<{ name: string; which: number[] }> {
  const out: Array<{ name: string; which: number[] }> = []
  const first = looks[0]?.crowd ?? {}
  for (const [name, a] of Object.entries(first)) {
    const later = looks.slice(1).map((l) => l?.crowd?.[name]).filter((b): b is Array<[number, number]> => Boolean(b) && b!.length === a.length)
    if (!later.length || a.length < 2) continue
    const tiles = [a, ...later].every((pts) => pts.every(([x, y]) => Math.abs(x) < 64 && Math.abs(y) < 64))
    const far = tiles ? 2 : 32
    const still = a.map(([x, y], i) => later.every((b) => Math.abs(x - b[i][0]) < far && Math.abs(y - b[i][1]) < far))
    const which = still.map((s, i) => (s ? i + 1 : 0)).filter(Boolean)
    if (which.length && which.length < a.length) out.push({ name, which })
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

type Harm = ReadonlyArray<readonly [number, number, number]>

/**
 * Whether its cars' x, and their y, are counted in tiles - no coordinate
 * past 64 - each on its own: a Crossy Road's cars had x in pixels and y as
 * the number of their lane.
 */
export function axes(harm: Harm): { xTiles: boolean; yTiles: boolean } {
  return { xTiles: harm.every(([x, , w]) => Math.abs(x) < 64 && w < 8), yTiles: harm.every(([, y]) => Math.abs(y) < 64) }
}

/* The player's fields for each axis: 't' in tiles, 'p' in pixels, '?' by size. */
const X_FIELDS: Array<[string, string]> = [['x', '?'], ['px', 'p'], ['col', 't'], ['gx', 't'], ['tx', 't'], ['tileX', 't'], ['gridX', 't'], ['cx', '?'], ['c', 't'], ['column', 't'], ['playerX', '?'], ['playerCol', 't'], ['screenX', 'p'], ['drawX', 'p']]
const Y_FIELDS: Array<[string, string]> = [['y', '?'], ['py', 'p'], ['row', 't'], ['gy', 't'], ['ty', 't'], ['tileY', 't'], ['gridY', 't'], ['cy', '?'], ['r', 't'], ['playerY', '?'], ['playerRow', 't'], ['screenY', 'p'], ['drawY', 'p']]

function onAxis(p: Record<string, number | boolean>, fields: Array<[string, string]>, tiles: boolean, unit: number): number | null {
  const kind = (v: number, said: string): 't' | 'p' => (said === '?' ? (Math.abs(v) >= 64 ? 'p' : 't') : (said as 't' | 'p'))
  for (const [k, said] of fields) {
    const v = p[k]
    if (typeof v === 'number' && kind(v, said) === (tiles ? 't' : 'p')) return v
  }
  /* None in the cars' units: the other kind, turned, where a tile's size is known. */
  if (!unit) return null
  for (const [k] of fields) {
    const v = p[k]
    if (typeof v !== 'number') continue
    return tiles ? v / unit : v * unit + unit / 2
  }
  return null
}

/**
 * Where the player stands, in the units its cars use: [x, y]. A Crossy
 * Road's player kept col and row in tiles and px and py in pixels; its
 * cars were in pixels. `scale` is pixels per tile, when known.
 */
export function standing(seen: Seen, scale = 0): [number, number] | null {
  const p = seen?.player
  const harm = seen?.harm
  if (!p || !harm?.length) return null
  const { xTiles, yTiles } = axes(harm)
  const unit = scale || seen?.tile || 0
  const x = onAxis(p, X_FIELDS, xTiles, unit)
  const y = onAxis(p, Y_FIELDS, yTiles, unit)
  return x === null || y === null ? null : [x, y]
}

/** How far apart its lanes are: the smallest gap between the y's its cars are on. */
export function laneGap(harm: ReadonlyArray<readonly [number, number, number]>): number {
  const ys = [...new Set(harm.map(([, y]) => Math.round(y * 10) / 10))].sort((a, b) => a - b)
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 0.2)
  if (gaps.length) return Math.min(...gaps)
  return harm.every(([x, y]) => Math.abs(x) < 64 && Math.abs(y) < 64) ? 1 : 40
}

/**
 * A tile, in the units its cars use: one, in a grid game; else the pixels
 * a hop measured, or the gap between lanes. Not the gap alone: a Crossy
 * Road's roads were four rows apart, and a player on the grass next to one
 * was taken to be standing in it.
 */
export function tileOf(harm: Harm, scale = 0, axis: 'x' | 'y' = 'y'): number {
  const { xTiles, yTiles } = axes(harm)
  if (axis === 'y' ? yTiles : xTiles) return 1
  return scale || laneGap(harm)
}

/** The cars in the lane the player stands in: the nearest lane, if it is within half a tile. */
export function inLane(seen: Seen, scale = 0): Array<readonly [number, number, number]> {
  const me = standing(seen, scale)
  const harm = seen?.harm
  if (!me || !harm?.length) return []
  const tile = tileOf(harm, scale || seen?.tile)
  const nearest = Math.min(...harm.map(([, y]) => Math.abs(y - me[1])))
  if (nearest > tile * 0.6) return []
  return harm.filter(([, y]) => Math.abs(Math.abs(y - me[1]) - nearest) < tile * 0.25)
}

/**
 * Puts the player in the nearest lane with cars, where walking there would
 * not do: a Crossy Road's first lane up was a river, and every walk ended
 * in it. Every field that says how far down it is moves by the same lanes -
 * row and targetRow in tiles, y and py in pixels - so the game draws it,
 * and tests it, where it now is. Null when there is nowhere to put it.
 */
export function tileScale(a: Seen, b: Seen): number {
  const p = a?.player
  const q = b?.player
  if (!p || !q) return 0
  for (const [tile, pixel] of [['row', 'y'], ['tileY', 'y'], ['gy', 'y'], ['ty', 'y'], ['gridY', 'y'], ['row', 'py'], ['col', 'x'], ['tileX', 'x'], ['gx', 'x'], ['tx', 'x'], ['gridX', 'x'], ['col', 'px']]) {
    const dt = (q[tile] as number) - (p[tile] as number)
    const dp = (q[pixel] as number) - (p[pixel] as number)
    if (typeof dt === 'number' && typeof dp === 'number' && Number.isFinite(dt / dp) && dt !== 0 && Math.abs(dp) > Math.abs(dt) * 4) return Math.round(Math.abs(dp / dt) * 100) / 100
  }
  return 0
}

/**
 * Puts the player in the nearest lane with cars - see below. `scale` is
 * pixels per tile, measured from a real hop: worked out from where the
 * player stood, a camera's offset in its y made it wrong, and the player
 * landed with its row in one lane and its y in another.
 */
export function teleportJs(seen: Seen, scale = 0): string | null {
  const me = standing(seen, scale)
  const p = seen?.player
  const harm = seen?.harm
  if (!me || !p || !harm?.length) return null
  const gap = laneGap(harm)
  const tiles = axes(harm).yTiles
  const lanes = [...new Set(harm.map(([, y]) => y))].filter((y) => Math.abs(y - me[1]) > gap * 0.4)
  if (!lanes.length) return null
  const to = lanes.reduce((a, b) => (Math.abs(b - me[1]) < Math.abs(a - me[1]) ? b : a))
  /* How many pixels a tile is, from the player's own two kinds of field;
     else the gap between lanes, near enough. */
  const tileField = Object.keys(p).find((k) => (/^(?:row|gy|ty|tileY|gridY)$/.test(k) || (k === 'r' && typeof p.c === 'number')) && typeof p[k] === 'number' && p[k] !== 0)
  const pixelField = Object.keys(p).find((k) => /^(?:y|py|cy|screenY|drawY)$/.test(k) && typeof p[k] === 'number' && Math.abs(p[k] as number) >= 64)
  const ratio = scale || seen?.tile || (tileField && pixelField ? (p[pixelField] as number) / (p[tileField] as number) : 0)
  /* Whole tiles, as a grid game's rows are whole. */
  const dTile = tiles ? Math.round(to - me[1]) : Math.round((to - me[1]) / (ratio || gap))
  const dPixel = tiles ? dTile * ratio : to - me[1]
  if (!dTile && !dPixel) return null
  /* Where it is, and where it is going or drawn - never how fast or which
     way: "...Y$" moved velY and dirY too, the player flew out of the lane,
     and that read as a hit from cars that never kill. `r` is a row only
     beside a `c`; alone it is a radius. */
  const vertical =
    /^(?:y|py|gy|ty|cy|row|tileY|gridY|screenY|drawY|renderY|displayY|playerY|playerRow|(?:target|prev|last|from|to|dest|next|old)(?:Y|Row))$/
  const rowR = typeof p.c === 'number'
  const moves: Record<string, number> = {}
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'number' || !(vertical.test(k) || (k === 'r' && rowR))) continue
    const isTile = Math.abs(v) < 64 && /row|Row|^(?:gy|ty|r)$|tileY|gridY/.test(k)
    const d = isTile ? dTile : Math.abs(v) >= 64 || !tiles ? dPixel : dTile
    if (d) moves[k] = d
  }
  if (!Object.keys(moves).length) return null
  return `(() => {
  const names = ['player', 'chicken', 'frog', 'hero', 'character', 'avatar', 'me', 'pacman', 'pacMan', 'pac', 'ship', 'bird']
  const get = (n) => { try { return (0, eval)('typeof ' + n + ' !== "undefined" ? ' + n + ' : undefined') } catch (e) { return undefined } }
  let p
  for (const n of names) { const v = get(n); if (v && typeof v === 'object') { p = v; break } }
  for (const box of ['state', 'game', 'world', 'gameState', 'G']) { if (p) break; const b = get(box); if (b && typeof b === 'object') for (const n of names) if (b[n] && typeof b[n] === 'object') { p = b[n]; break } }
  /* Or kept loose in the object it keeps its state in: playerX, playerY. */
  for (const box of ['state', 'game', 'world', 'gameState', 'G']) { if (p) break; const b = get(box); if (b && typeof b === 'object' && Object.keys(b).some((k) => /^(?:player|chicken|frog|hero|pacman|pac)(?:x|y|row|col)$/i.test(k))) p = b }
  if (!p) return false
  const moves = ${JSON.stringify(moves)}
  for (const k in moves) if (typeof p[k] === 'number') p[k] += moves[k]
  return true
})()`
}

/**
 * Cars on top of one another in a lane, in two looks a second or more
 * apart: they start in one place and move as one. A Crossy Road made each
 * lane's cars at random places and then gave them all the same progress,
 * so three cars drove as one, with the rest of the road empty - and the
 * user asked for the cars to be spaced out.
 */
export function bunched(a: Seen, b: Seen, scale = 0): string {
  if (!a?.harm?.length || !b?.harm?.length || (b.t ?? 0) - (a.t ?? 0) < 1000) return ''
  const tile = tileOf(a.harm, scale || a.tile)
  const across = tileOf(a.harm, scale || a.tile, 'x')
  const stacks = (seen: Seen): Map<number, number> => {
    const lanes = new Map<number, Array<readonly [number, number, number]>>()
    for (const h of seen!.harm!) {
      const y = Math.round(h[1] / (tile / 2))
      lanes.set(y, [...(lanes.get(y) ?? []), h])
    }
    const out = new Map<number, number>()
    for (const [y, cars] of lanes) {
      const xs = cars.map(([x, , w]) => x + w / 2).sort((m, n) => m - n)
      let on = 0
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] < across * 0.5) on++
      if (on) out.set(y, on)
    }
    return out
  }
  const first = stacks(a)
  const later = stacks(b)
  const both = [...first.keys()].filter((y) => later.has(y))
  if (!both.length) return ''
  const n = both.reduce((sum, y) => sum + Math.min(first.get(y)!, later.get(y)!), 0)
  return `In ${both.length} of its lanes, cars sit on top of one another and move as one (${n} car${n === 1 ? '' : 's'} hidden under another, the same a second later): they look like one car, with the rest of the lane empty. Space each lane's cars out along it when it is made, each at its own x - and give each its own position, not one shared progress.`
}

/** A sign the game itself gives that it is sparing the player for now. */
function spared(seen: Seen): boolean {
  const p = seen?.player ?? {}
  return Object.entries(p).some(([k, v]) => /invinc|invuln|grace|shield|immun|safe|respawn|spawnTimer|flash|blink/i.test(k) && (v === true || (typeof v === 'number' && v > 0)))
}

/**
 * The player stood still in a lane with cars, looked at every tenth of a
 * second: did a car go right through where it stood, and nothing happen?
 * "make it when I die, when I'm hit by the cars" came back said to be done,
 * twice, and the cars still drove through the chicken: the test played it,
 * it moved, it ended - in the river - and nothing ever stood in the road.
 *
 * "hit" when something happened - over, a life gone, the player moved or
 * vanished; "missed" when a car crossed it and the game went on as if not;
 * null when no car came by.
 */
export function standInTraffic(looks: readonly Seen[], scale = 0): { verdict: 'hit' | 'missed' | null; line: string } {
  const first = looks[0]
  const unit = scale || first?.tile || 0
  const me = standing(first, unit)
  if (!me || !first?.harm?.length) return { verdict: null, line: '' }
  const gap = tileOf(first.harm, unit)
  const across = tileOf(first.harm, unit, 'x')
  const { xTiles } = axes(first.harm)
  const lives = first.lives
  let crossedAt = -1
  let crossing = ''
  for (let i = 1; i < looks.length; i++) {
    const s = looks[i]
    const now = standing(s, unit)
    const happened =
      !s ||
      s.over === true ||
      (typeof lives === 'number' && typeof s.lives === 'number' && s.lives < lives) ||
      !now ||
      Math.abs(now[0] - me[0]) > across * 0.5 ||
      Math.abs(now[1] - me[1]) > gap * 0.5
    if (happened) return { verdict: 'hit', line: 'Standing still in a lane with cars, the player was hit, and that ended its run.' }
    if (crossedAt >= 0) {
      /* Two thirds of a second after a car went through: nothing came of it. */
      if ((s?.t ?? 0) - (looks[crossedAt]?.t ?? 0) > 650) {
        return {
          verdict: 'missed',
          line:
            `Wumpy stood the player still in a lane with cars - at x ${me[0]}, y ${me[1]} - and ${crossing}, right through where it stood: nothing happened. ` +
            'The game went on, no life lost, the player still there. Its cars do not hit the player. Check the collision test with these real numbers: ' +
            "is it run every frame, does it compare the car's lane with the player's in the same units, and the car's x span with the player's?"
        }
      }
      continue
    }
    if (spared(s)) continue
    const prev = looks[i - 1]
    const a = inLane(prev, unit)
    const b = inLane(s, unit)
    if (!a.length || a.length !== b.length) continue
    for (let k = 0; k < a.length; k++) {
      const [x0, , w0] = a[k]
      const [x1, , w1] = b[k]
      /* Faster than ten tiles a second is one going off one side and
         coming back on the other, not a crossing. */
      const seconds = Math.max(0.05, ((s?.t ?? 0) - (prev?.t ?? 0)) / 1000)
      if (Math.abs(x1 - x0) / seconds > (xTiles ? 10 : Math.max(600, (s?.width ?? 0) * 1.2))) continue
      const c0 = x0 + w0 / 2 - me[0]
      const c1 = x1 + w1 / 2 - me[0]
      if (c0 === 0 || c1 === 0 || Math.sign(c0) !== Math.sign(c1)) {
        crossedAt = i
        crossing = `a car went from x ${x0} to x ${x1}`
        break
      }
    }
  }
  return { verdict: null, line: '' }
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
  /* By half a tile, or a few pixels: a player drifting with a log by a
     twentieth of a tile - "col 3.44 became col 3.4" - had not moved, and
     a game whose player never hopped passed for one that did. */
  const far = (k: string): boolean => {
    const x = b[k] as number
    const y = a[k] as number
    if (typeof x !== 'number' || typeof y !== 'number') return b[k] !== a[k]
    return Math.abs(x - y) >= (Math.abs(x) < 64 && Math.abs(y) < 64 ? 0.5 : 4)
  }
  const changed = (where.length ? where : watched).filter(far)
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

/**
 * A map typed as rows of text that cannot be right: rows of different
 * lengths, or a different number of rows from the ROWS beside it. Models
 * miscount them - a maze game typed 32 rows under `ROWS = 31`, built an
 * empty maze from them, and crashed reading it - and the rules saying never
 * to type one did not stop even the strongest model. Read from the source,
 * so it is said before anything is played. Null when there is no such map,
 * or it lines up.
 */
export function typedMapProblem(source: string): string | null {
  /* Or typed as rows of numbers: [1,1,2,1,...], each row a line - a maze
     game's rows ran to 28 and 29, and nothing said so. */
  const numeric = source.match(/\[\s*(?:\[[\d\s,]{15,}\]\s*,\s*){7,}\[[\d\s,]{15,}\]\s*,?\s*\]/g) ?? []
  for (const array of numeric) {
    const rows = [...array.matchAll(/\[([\d\s,]+)\]/g)].map((m) => m[1].split(',').filter((x) => x.trim()).map((x) => x.trim()).join(''))
    const problem = rowProblems(source, array, rows)
    if (problem) return problem.replace('rows of text', 'rows of numbers')
  }
  const arrays = source.match(/\[\s*(?:(["'`])[^"'`\n]{3,}\1\s*,\s*){7,}(["'`])[^"'`\n]{3,}\2\s*,?\s*\]/g) ?? []
  for (const array of arrays) {
    const rows = [...array.matchAll(/(["'`])([^"'`\n]*)\1/g)].map((m) => m[2])
    /* A map: walls, dots and spaces, a few letters for who starts where. */
    const mapLike = rows.filter((r) => /^[#.\s=|oO*+PGXWEeSs0-9-]+$/.test(r) && /[#=|X0-9]/.test(r)).length
    if (mapLike < rows.length * 0.8) continue
    const problem = rowProblems(source, array, rows)
    if (problem) return problem
  }
  return null
}

/** For typedMapProblem: what is wrong with one typed map's rows, or null. */
function rowProblems(source: string, array: string, rows: string[]): string | null {
  const counts = new Map<number, number>()
  for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1)
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const odd = rows.map((r, i) => ({ i, n: r.length })).filter((r) => r.n !== common)
  const at = source.indexOf(array)
  const before = source.slice(Math.max(0, at - 4000), at) + source.slice(at + array.length, at + array.length + 4000)
  const declared = /\bROWS\s*=\s*(\d+)\b/.exec(before)
  const rowsSaid = declared ? Number(declared[1]) : null
  const problems: string[] = []
  if (odd.length)
    problems.push(
      `its rows are not all one length: most are ${common} long, but ${odd
        .slice(0, 6)
        .map((r) => `row ${r.i} is ${r.n}`)
        .join(', ')}${odd.length > 6 ? ` and ${odd.length - 6} more` : ''}`
    )
  if (rowsSaid !== null && rowsSaid !== rows.length) problems.push(`it has ${rows.length} rows, where ROWS = ${rowsSaid}`)
  if (!problems.length) return null
  return (
    `The map is typed as ${rows.length} rows of text, and ${problems.join('; and ')}. ` +
    'Do not count to fix it: build the map in code, as your rules say - fill a grid from a list of ' +
    'wall rectangles, mirror it left to right - and take ROWS and COLS from the grid itself.'
  )
}

/**
 * The map around the player, for a player that did not move: the page's own
 * grid, a few rows either side, the player marked @. A maze game's player
 * stood inside a wall - its maze, built in code, had filled the middle
 * columns solid - and its agent spent all ten of its steps reading the map
 * three rows at a time, and never got to change anything. One look shows it.
 * Returns { name, row, col, under, rows } or null when there is no grid or
 * no player to place on it.
 */
export const AROUND_JS = `(() => {
  const get = (n) => { try { return eval(n) } catch { return undefined } }
  let grid, name
  for (const n of ['maze', 'MAZE', 'grid', 'GRID', 'map', 'MAP', 'level', 'board', 'tiles', 'world', 'layout']) {
    const v = get(n)
    if (Array.isArray(v) && v.length >= 8 && v[0] && (Array.isArray(v[0]) || typeof v[0] === 'string') && v[0].length >= 8) { grid = v; name = n; break }
  }
  if (!grid) return null
  let p
  for (const n of ['player', 'pacman', 'pac', 'hero', 'you']) { const v = get(n); if (v && typeof v === 'object') { p = v; break } }
  if (!p) return null
  let x = [p.col, p.tx, p.gridX, p.tileX, p.x].find((v) => typeof v === 'number')
  let y = [p.row, p.ty, p.gridY, p.tileY, p.y].find((v) => typeof v === 'number')
  if (x === undefined || y === undefined) return null
  const rowsN = grid.length, colsN = grid[0].length
  if (x >= colsN || y >= rowsN) {
    const t = [get('TILE'), get('TILE_SIZE'), get('CELL'), get('CELL_SIZE'), get('GRID'), get('SIZE'), get('tileSize')].find((v) => typeof v === 'number' && v > 1)
    if (!t) return null
    x /= t; y /= t
  }
  const c = Math.floor(x), r = Math.floor(y)
  const cell = (i, j) => { const v = typeof grid[i] === 'string' ? grid[i][j] : grid[i] && grid[i][j]; return v === undefined ? ' ' : typeof v === 'object' ? '?' : String(v).slice(0, 1) || ' ' }
  const rows = []
  for (let i = Math.max(0, r - 3); i <= Math.min(rowsN - 1, r + 3); i++) {
    let line = ''
    for (let j = Math.max(0, c - 8); j <= Math.min(colsN - 1, c + 8); j++) line += i === r && j === c ? '@' : cell(i, j)
    rows.push(line)
  }
  return { name, row: r, col: c, under: cell(r, c), rows }
})()`

/** AROUND_JS's answer, said: the lines of the map with the player on it. */
export function aroundLine(a: { name: string; row: number; col: number; under: string; rows: string[] } | null): string {
  if (!a || !Array.isArray(a.rows) || !a.rows.length) return ''
  return (
    `\nWhere the player stands, in its ${a.name} (row ${a.row}, col ${a.col}, on a "${a.under}"; @ is the player):\n` +
    a.rows.map((l) => `  ${l}`).join('\n')
  )
}

/**
 * "init is not defined", of a page with `function init(` in it: the function
 * is there, but inside another one whose closing brace is missing, so it is
 * out of reach. A maze game written a function to a line lost the last `}`
 * of checkCollisions; its agent added braces elsewhere, swapped a syntax
 * error for this one, and never saw the cause. Read from the source with a
 * plain brace count (strings and comments skipped): which function is still
 * open where the missing one is declared. Null when it is not that.
 */
export function nestedFunction(source: string, errors: readonly string[]): string | null {
  for (const e of errors) {
    const m = /\b([A-Za-z_$][\w$]*) is not defined/.exec(e)
    if (!m) continue
    const name = m[1]
    const decl = new RegExp(`\\bfunction\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`).exec(source)
    if (!decl) continue
    /* Open braces, each with the function whose body it starts, if any. */
    const stack: Array<string | null> = []
    let pending: string | null = null
    let parens = 0
    const lineOf = (i: number): number => source.slice(0, i).split('\n').length
    const opened = new Map<number, number>()
    for (let i = 0; i < decl.index; i++) {
      const ch = source[i]
      const two = source.slice(i, i + 2)
      if (two === '//') { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; continue }
      if (two === '/*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 1; continue }
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1
        while (j < source.length && source[j] !== ch) { if (source[j] === '\\') j++; j++ }
        i = j
        continue
      }
      if (ch === '<' && /^<script\b/i.test(source.slice(i, i + 7))) { stack.length = 0; pending = null; continue }
      const fn = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source.slice(i, i + 60))
      if (fn && (i === 0 || !/[\w$]/.test(source[i - 1]))) { pending = fn[1]; parens = 0 }
      if (ch === '(') parens++
      if (ch === ')') parens--
      if (ch === '{') {
        const owner = pending && parens === 0 ? pending : null
        if (owner) { opened.set(stack.length, i); pending = null }
        stack.push(owner)
      }
      if (ch === '}') stack.pop()
    }
    const outer = stack.findIndex((owner) => owner !== null)
    if (outer < 0) continue
    const owner = stack[outer]!
    return (
      `\`${name}\` is written in the page (line ${lineOf(decl.index)}), yet not defined where it is called: it sits inside ` +
      `\`${owner}\` (from line ${lineOf(opened.get(outer) ?? 0)}), whose braces never close before it. A \`}\` is missing ` +
      `at the end of ${owner} - add exactly that one, and nothing elsewhere.`
    )
  }
  return null
}
