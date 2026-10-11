/**
 * The speed meter, which was reporting impossible numbers.
 *
 * Run with: npm run check:speed
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const out = '.speed-check.mjs'
await build({
  entryPoints: ['src/shared/speed.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const S = await import(pathToFileURL(out).href)
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

/* The reported bug: 8 tokens in one chunk read as 8,000 a second. */
check('a single-chunk reply reports nothing', S.tokensPerSecond(8, 0), null)
check('nor does a sub-millisecond window', S.tokensPerSecond(400, 0.4), null)
check('nor one just under the floor', S.tokensPerSecond(100, S.MIN_WINDOW_MS - 1), null)

/* An ordinary answer still reports, and reports correctly. */
check('120 tokens in 2s is 60 a second', S.tokensPerSecond(120, 2000), 60)
check('at the floor it reports', S.tokensPerSecond(60, S.MIN_WINDOW_MS), (60 / S.MIN_WINDOW_MS) * 1000)

/* One word answered instantly is not a throughput measurement. */
check('a one-token reply reports nothing', S.tokensPerSecond(1, 5000), null)
check('nor three', S.tokensPerSecond(3, 5000), null)
check('four is enough', S.tokensPerSecond(4, 1000), 4)

/* Nothing here may produce Infinity or NaN, which is what reached the UI. */
for (const [c, w] of [[0, 0], [10, 0], [0, 1000], [NaN, 100], [10, NaN], [Infinity, 1000]]) {
  const got = S.tokensPerSecond(c, w)
  if (got !== null && !Number.isFinite(got)) {
    failed++
    console.log(`FAIL tokensPerSecond(${c}, ${w}) = ${got}`)
  }
  count++
}
console.log(`ok   no input produces Infinity or NaN`)

console.log(`${String.fromCharCode(10)}${count - failed}/${count} speed checks correct`)
process.exit(failed === 0 ? 0 : 1)
