/**
 * No invisible characters in the source. None.
 *
 * This is the fourth appearance of one escape bug in this repo and the first
 * one that could not be seen. The earlier three ate a backslash and left
 * something readably wrong - `C:Users...` instead of `C:\Users\...` - and a
 * scanner in check-blocks.mjs now catches those in the prompt text.
 *
 * This one wrote a literal 0x08 BACKSPACE into src/shared/activity.ts, 59 of
 * them, one for every `\b` word boundary in two regex tables. The file looked
 * correct in an editor and in a terminal, because a backspace renders as
 * nothing. It compiled. TypeScript passed. The regexes were valid - a control
 * character is a perfectly legal literal - and every one of them had been
 * silently rewritten to require an actual backspace in the input, so the
 * entire table matched nothing and the feature would have shipped saying
 * "Running" forever with no error anywhere.
 *
 * The route: `\\b` written into a JSON tool argument arrives as `\b`, and a
 * non-raw Python string turns `\b` into 0x08. The lesson is not about Python.
 * It is that a file can be wrong in a way no amount of reading it will show,
 * so the check has to be mechanical.
 *
 * Tab, newline and carriage return are the only control characters a source
 * file has any business containing.
 *
 * Run with: npm run check:controlchars
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src', 'scripts']
const SKIP = new Set(['node_modules', 'bin', 'obj', 'out', 'dist', '.git', 'assets'])
const ALLOWED = new Set([9, 10, 13]) // tab, newline, carriage return

/** Text we wrote. A .png is full of control bytes and is not source. */
const TEXT = /\.(ts|tsx|mjs|js|json|css|html|cs|csproj|md|ps1)$/i

function walk(dir, found = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return found // a directory we may not read is not a source file
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    let s
    try {
      s = statSync(path)
    } catch {
      continue
    }
    if (s.isDirectory()) walk(path, found)
    else if (TEXT.test(name)) found.push(path)
  }
  return found
}

const files = ROOTS.flatMap((r) => walk(r))

let failed = 0
let scanned = 0
const NAMES = { 0: 'NUL', 7: 'BEL', 8: 'BACKSPACE', 11: 'VERTICAL TAB', 12: 'FORM FEED', 27: 'ESC' }

for (const file of files) {
  const bytes = readFileSync(file)
  scanned++
  const hits = new Map()
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b < 32 && !ALLOWED.has(b)) hits.set(b, (hits.get(b) ?? 0) + 1)
  }
  if (hits.size === 0) continue
  failed++
  for (const [byte, count] of hits) {
    /* The line number, because "somewhere in this file" is not actionable
       for something you cannot see. */
    const upto = bytes.subarray(0, bytes.indexOf(byte)).toString('utf8')
    const line = upto.split(String.fromCharCode(10)).length
    console.log(
      `FAIL ${file}: ${count} x 0x${byte.toString(16).padStart(2, '0')} ` +
        `${NAMES[byte] ?? 'control character'}, first at line ${line}`
    )
  }
}

console.log(
  `${String.fromCharCode(10)}${scanned - failed}/${scanned} source files are free of ` +
    'invisible control characters'
)
if (failed) {
  console.log(
    'A backslash escape was almost certainly eaten on the way in. Rewrite the ' +
      'line with an editing tool rather than through a shell or Python string.'
  )
  process.exit(1)
}
