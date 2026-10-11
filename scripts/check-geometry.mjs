/**
 * Where the panel sits, and what it must not cover.
 *
 * Reported with a screenshot: right-docked, the panel sat over the minimise,
 * maximise and close buttons of the maximised window behind it, so they could
 * neither be seen nor clicked. The panel is always-on-top and frameless, so
 * nothing about that is obvious from inside the app - it only shows up when
 * someone goes to close the window underneath.
 *
 * Run with: npm run check:geometry
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.geometry-check.mjs'
await build({
  entryPoints: ['src/shared/geometry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const G = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
let count = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  count++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(56)} ${JSON.stringify(got)}` +
      (ok ? '' : `   expected ${JSON.stringify(want)}`)
  )
}

/* A 1920x1200 display with a 48px taskbar, which is what this was seen on. */
const SCREEN = { x: 0, y: 0, width: 1920, height: 1152 }
const SIZES = { tallWidth: 440, compactWidth: 460, compactHeight: 420 }
const DOCKS = ['left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']

/* ------------------------------------- the caption buttons stay visible */

/**
 * The whole point. Windows 11 puts the caption buttons in the top 32dip of a
 * maximised window; every dock that touches the top must start below them.
 */
for (const dock of DOCKS) {
  if (dock.startsWith('bottom')) continue
  const top = G.cardTop(dock, SCREEN, SIZES)
  check(`${dock} clears the caption buttons`, top >= SCREEN.y + 32, true)
}

check('and by the stated clearance', G.cardTop('right', SCREEN, SIZES), G.TITLEBAR_CLEARANCE)

/* ----------------------------------------- and it still fits on screen */

for (const dock of DOCKS) {
  const r = G.geometryFor(dock, SCREEN, SIZES)
  const fits =
    r.x >= SCREEN.x &&
    r.y >= SCREEN.y &&
    r.x + r.width <= SCREEN.x + SCREEN.width &&
    r.y + r.height <= SCREEN.y + SCREEN.height
  check(`${dock} stays inside the work area`, fits, true)
}

/* The bottom edge keeps its ordinary margin; only the top gained room. */
const tall = G.geometryFor('right', SCREEN, SIZES)
check('the bottom margin is unchanged', SCREEN.height - (tall.y + tall.height), G.EDGE_MARGIN)
check('a tall panel is shorter than it was', tall.height, SCREEN.height - G.TITLEBAR_CLEARANCE - G.EDGE_MARGIN)
check('right dock is flush to the right edge', tall.x + tall.width, SCREEN.width)
check('left dock is flush to the left', G.geometryFor('left', SCREEN, SIZES).x, 0)

/* -------------------------------------------- a second, offset display */

/**
 * workArea.x and .y are not zero on a second monitor, and a clearance added
 * to the wrong one puts the panel on the primary screen.
 */
const SECOND = { x: 1920, y: -120, width: 1280, height: 1024 }
const onSecond = G.geometryFor('right', SECOND, SIZES)
check('the panel lands on the second screen', onSecond.x >= SECOND.x, true)
check('and is offset from ITS top, not zero', onSecond.y, SECOND.y + G.TITLEBAR_CLEARANCE)

/* --------------------------------------------------- a tiny display */

/** A netbook-sized work area must not produce a negative height. */
const TINY = { x: 0, y: 0, width: 800, height: 150 }
for (const dock of DOCKS) {
  const r = G.geometryFor(dock, TINY, SIZES)
  check(`${dock} never has a negative size on a tiny screen`, r.width > 0 && r.height > 0, true)
}

console.log(`${String.fromCharCode(10)}${count - failed}/${count} geometry checks correct`)
process.exit(failed === 0 ? 0 : 1)
