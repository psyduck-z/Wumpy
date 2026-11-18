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
 * The play test. The page's `player` (or `chicken`, `frog`, `hero`... -
 * whatever it is called) and `score` are read, the up arrow is pressed
 * three times, and they are read again. A game whose player never moved
 * for its keys is the most common way a written game fails: a Crossy Road
 * came back where each hop took eight seconds and never landed, with a
 * clean console. Only plain numbers and flags are kept. Run by main in a
 * hidden window (main/pagecheck.ts); these are the scripts it runs there.
 */
export const LOOK_JS = `(() => {
  const pick = (v) => {
    if (v === null || typeof v !== 'object') return typeof v === 'number' || typeof v === 'boolean' ? v : undefined
    const out = {}
    for (const k in v) { const x = v[k]; if (typeof x === 'number') out[k] = Math.round(x * 100) / 100; else if (typeof x === 'boolean') out[k] = x }
    return out
  }
  const seen = {}
  const names = ['player', 'chicken', 'frog', 'hero', 'character', 'avatar', 'me']
  const get = (name) => { try { return (0, eval)('typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined') } catch (e) { return undefined } }
  for (const name of names) { const v = get(name); if (v && typeof v === 'object') { seen.player = pick(v); break } }
  /* Or one level down, in the object a game keeps its state in. */
  for (const box of ['state', 'game', 'world', 'gameState', 'G']) {
    if (seen.player) break
    const b = get(box)
    if (!b || typeof b !== 'object') continue
    for (const name of names) { const v = b[name]; if (v && typeof v === 'object') { seen.player = pick(v); break } }
    /* Or flat in it: playerX, playerY, chickenRow. */
    if (!seen.player) {
      const flat = {}
      for (const k in b) if (/^(?:player|chicken|frog|hero)(?:x|y|row|col)$/i.test(k) && typeof b[k] === 'number') flat[k] = b[k]
      if (Object.keys(flat).length) seen.player = flat
    }
    if (!seen.score && typeof b.score === 'number') seen.score = b.score
  }
  if (seen.score === undefined) seen.score = pick(get('score'))
  return seen
})()`

export function pressJs(key: string): string {
  const code = key === 'ArrowUp' ? 38 : key === 'ArrowDown' ? 40 : key === 'ArrowLeft' ? 37 : key === 'ArrowRight' ? 39 : 0
  /* Once, at the focused element: it bubbles to the document and the
     window. Sent to both, every press counted twice. */
  return `(() => { const o = { key: '${key}', code: '${key}', keyCode: ${code}, which: ${code}, bubbles: true }; const t = document.activeElement || document.body || document; t.dispatchEvent(new KeyboardEvent('keydown', o)); t.dispatchEvent(new KeyboardEvent('keyup', o)); return true })()`
}

type Seen = { player?: Record<string, number | boolean>; score?: unknown } | null

/** Whether the player moved: by where it IS, not where it is headed. */
export function playFrom(before: Seen, after: Seen): { moved: boolean | null; line: string } {
  const b = before?.player
  const a = after?.player
  if (!b || !a) return { moved: null, line: '' }
  /* A hop that set `targetRow` and never landed left `row` where it was.
     Any number counts only when there is no position-like field at all. */
  const POSITION = /^(?:player|chicken|frog|hero)?(?:x|y|row|col|column|lane|tx|ty|gx|gy|px|py|tilex|tiley|gridx|gridy|posx|posy|cellx|celly)$/i
  const watched = Object.keys(b).filter((k) => typeof b[k] === 'number')
  const where = watched.filter((k) => POSITION.test(k))
  const changed = (where.length ? where : watched).filter((k) => b[k] !== a[k])
  const said = (o: Record<string, number | boolean>): string =>
    Object.entries(o)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
  return changed.length
    ? { moved: true, line: `Pressing the up arrow three times moved the player: ${said(b)} became ${said(a)}.` }
    : { moved: false, line: `Pressing the up arrow three times did not move the player at all: it stayed ${said(b)}.` }
}

/** The hand-back: what Wumpy found, said to be from the app. */
export function pageErrorText(path: string, errors: readonly string[]): string {
  return [
    `Wumpy loaded ${path} out of sight to check it, and its console showed:`,
    ...errors.map((e) => `- ${e}`),
    '',
    'That is a bug in the page you wrote. Read the file, fix the cause - and anything else wrong you see on the way - and write it again. Do not tell the user it works until it loads clean and its player moves. This was sent by Wumpy, not typed by the user.'
  ].join('\n')
}

/** How many times one request may be sent back for errors before a person decides. */
export const PAGE_ROUNDS = 2
