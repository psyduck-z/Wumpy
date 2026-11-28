/**
 * The conversation as it is sent (src/shared/wire.ts): "make Wumpy more
 * context efficient". A file written in a reply goes out again on every turn
 * after; once it is rewritten, or a few turns old, the copy goes out as a
 * line saying what was written where.
 *
 * The real model, reading such a line and asked to change the file: the
 * `--context-check` mode in main/index.ts.
 *
 * Run with: node scripts/check-wire.mjs
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failed = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(64)} ${JSON.stringify(got).slice(0, 90)}` + (ok ? '' : `   expected ${JSON.stringify(want)}`))
}

const out = join(process.cwd(), '.wire-check.mjs')
await build({ entryPoints: ['src/shared/wire.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' })
const W = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const LF = String.fromCharCode(10)
const F = '`'.repeat(3)
const body = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join(LF)
const write = (path, n, tag) => `${F}wumpy-write${LF}# Save it${LF}path: ${path}${LF}---${LF}${body(n, tag)}${LF}${F}`
const u = (content) => ({ role: 'user', content })
const a = (content) => ({ role: 'assistant', content })

/* Rewritten: the old copy goes, the new one stays. */
const fixes = [u('make snake'), a(`Here.${LF}${write('~/snake.html', 40, 'v1')}`), u('it does not start'), a(`Fixed.${LF}${write('~/snake.html', 40, 'v2')}`)]
const sent = W.withoutOldFiles(fixes)
check('an out-of-date copy is left out', sent[1].content.includes('v1 0'), false)
check('and said to be an earlier version', /earlier version, replaced by a later write/.test(sent[1].content), true)
check('the latest copy is kept', sent[3].content.includes('v2 39'), true)
check('the transcript itself is untouched', fixes[1].content.includes('v1 0'), true)

/* Old: after KEEP_TURNS messages of theirs or handed back. */
const later = (n) => Array.from({ length: n }, (_, i) => [u(`q${i}`), a(`a${i}`)]).flat()
const fresh = W.withoutOldFiles([u('make it'), a(write('~/a.py', 30)), ...later(W.KEEP_TURNS - 1)])
check('a recent write is kept for the fix asked straight after', fresh[1].content.includes('line 29'), true)
const old = W.withoutOldFiles([u('make it'), a(write('~/a.py', 30)), ...later(W.KEEP_TURNS)])
check(`after ${W.KEEP_TURNS} more of theirs it is left out`, old[1].content.includes('line 29'), false)
check('saying where, how long, and to read it before changing it', /wrote ~\/a\.py \("Save it"\), 30 lines[\s\S]*read it first with cat/.test(old[1].content), true)
check('as a sentence, not as a block it could copy', /```/.test(old[1].content), false)

/* What is never left out. */
const small = W.withoutOldFiles([u('x'), a(write('~/n.txt', 3)), ...later(5)])
check('a small file stays where it is', small[1].content.includes('line 2'), true)
const agent = `${F}wumpy-write${LF}path: ~/g.html${LF}from: agent-1${LF}${F}`
check('a write from an agent has nothing to leave out', W.withoutOldFiles([u('x'), a(agent), ...later(5)])[1].content, agent)
const code = `${F}python${LF}${body(40)}${LF}${F}`
check('code shown in an answer is not a file, and stays', W.withoutOldFiles([u('x'), a(code), ...later(5)])[1].content, code)
check('a conversation with no writes is passed through', W.withoutOldFiles(later(3)).length, 6)

/* Wired in, and counted the same way by the meter. */
const main = readFileSync('src/main/index.ts', 'utf8')
const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
check('the sender leaves them out', /withoutOldFiles\(\s*\/\*[\s\S]*?withSentTimes\(req\.messages\)/.test(main), true)
check('and the meter counts what is sent', /withoutOldFiles\(counted\)/.test(app), true)
check('the meter measures the Linux instructions on Linux', /platform: window\.wumpy\.platform === 'linux'/.test(app), true)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nold and out-of-date file contents are left out of what is sent')
