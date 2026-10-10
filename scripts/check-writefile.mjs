/**
 * Checks writing a file: what gets parsed out of the block, and where it is
 * allowed to land.
 *
 * The block exists because of a real failure. Asked for a Python script, the
 * model wrote `New-Item -Content { ...python... }`; PowerShell reads braces as a
 * script block, so every line of Python was parsed as PowerShell, and the eight
 * parser errors that came back were then read as mistakes in the Python. The
 * conversation could not converge, because nothing was ever wrong with the
 * Python. So the first half of this file is about content surviving untouched -
 * every `$`, backtick and brace that a shell would have eaten.
 *
 * The second half is about the destination. A file written into the Startup
 * folder runs at every login, which is the difference between "wrote a script"
 * and "installed something".
 *
 * Run with: npm run check:writefile
 */
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = join(process.cwd(), '.write-check.mjs')
await build({
  entryPoints: ['src/shared/writefile.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const W = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

let failed = 0
const pad = (s, n) => String(s).padEnd(n)
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${pad(what, 50)} ${JSON.stringify(got)?.slice(0, 60)}`)
  if (!ok)
    console.log(`${' '.repeat(5)}${pad('', 50)} expected ${JSON.stringify(want)?.slice(0, 60)}`)
}

/* ---------------------------------------------------------------- the block */

const full = W.readWriteRequest(
  [
    '# Create the folder analysis script',
    'path: ~/Downloads/analysis.py',
    '---',
    'import os',
    '',
    'print(1)'
  ].join('\n')
)
check('the reason', full.reason, 'Create the folder analysis script')
check('the path', full.path, '~/Downloads/analysis.py')
check('the content, blank line and all', full.content, 'import os\n\nprint(1)')

// A small model will leave the separator out. That must still work.
const loose = W.readWriteRequest(['# why', 'path: ~/x.py', 'print(1)'].join('\n'))
check('no separator still parses', loose.content, 'print(1)')
check('and still finds the path', loose.path, '~/x.py')

const quoted = W.readWriteRequest(['path: "~/My Files/a b.py"', '---', 'x'].join('\n'))
check('a quoted path is unquoted', quoted.path, '~/My Files/a b.py')

/**
 * The whole point. Every one of these is a character a shell would have treated
 * as syntax, and the reason the original approach could not be made to work.
 */
const hostile = [
  '$HOME = "not a variable"',
  'price = "$100"',
  'backtick = `not an escape`',
  'braces = { "a": 1 }',
  'quote = "she said \\"hi\\""',
  "single = 'it''s fine'",
  'semi = 1; echo pwned',
  'pipe = a | b',
  'amp = x && y',
  'percent = 50%',
  'caret = 2^8',
  'newline_literal = "a\\nb"',
  '# a comment with # hashes # in it',
  'path: not actually a path line'
].join('\n')
const kept = W.readWriteRequest(`# why\npath: ~/x.py\n---\n${hostile}`)
check('content is kept byte for byte', kept.content, hostile)

// Indentation is the one thing Python cannot survive losing.
const indented = ['def f():', '    if True:', '        return 1', '', '    return 0'].join('\n')
check(
  'indentation survives',
  W.readWriteRequest(`path: ~/a.py\n---\n${indented}`).content,
  indented
)

// A '#' after the content has begun is a comment in the file, not a reason.
const hashes = W.readWriteRequest('# real reason\npath: ~/a.py\n---\n# python comment\nx = 1')
check('only leading # lines are the reason', hashes.reason, 'real reason')
check('and the rest stay in the file', hashes.content, '# python comment\nx = 1')

check('a block with no path', W.readWriteRequest('# thinking out loud').path, null)

/* ------------------------------------------------------------ the destination */

const env = {
  home: 'C:\\Users\\zecha',
  cwd: 'C:\\Users\\zecha',
  separator: '\\',
  // A deliberately simple win32 resolve, so these cases read as what they are.
  resolve: (...parts) => {
    let path = ''
    for (const part of parts) {
      if (/^[a-zA-Z]:[\\/]/.test(part) || /^[\\/]/.test(part)) path = part
      else path = path ? `${path}\\${part}` : part
    }
    const bits = []
    for (const bit of path.replace(/\//g, '\\').split('\\')) {
      if (bit === '.' || bit === '') {
        if (bits.length === 0) bits.push(bit)
        continue
      }
      if (bit === '..') bits.splice(Math.max(1, bits.length - 1), 1)
      else bits.push(bit)
    }
    return bits.join('\\')
  }
}
const where = (p) => W.checkWritePath(p, env)

check('a tilde path', where('~/Downloads/a.py').path, 'C:\\Users\\zecha\\Downloads\\a.py')
check(
  '$HOME, as the model writes it',
  where('$HOME\\Downloads\\a.py').path,
  'C:\\Users\\zecha\\Downloads\\a.py'
)
check('%USERPROFILE%', where('%USERPROFILE%\\a.py').path, 'C:\\Users\\zecha\\a.py')
check('$env:USERPROFILE', where('$env:USERPROFILE\\a.py').path, 'C:\\Users\\zecha\\a.py')
check('a bare name lands in the working folder', where('a.py').path, 'C:\\Users\\zecha\\a.py')
check('an absolute path inside home', where('C:\\Users\\zecha\\Documents\\a.py').ok, true)

/**
 * The refusals. Traversal is checked by where the path lands, not by how it is
 * spelled, so a path that climbs out and back in is still fine.
 */
check('climbing out of home', where('~/Downloads/../../../Windows/System32/x.dll').ok, false)
check('another user', where('C:\\Users\\someone-else\\a.py').ok, false)
check('Windows itself', where('C:\\Windows\\System32\\drivers\\etc\\hosts').ok, false)
check('Program Files', where('C:\\Program Files\\x\\a.exe').ok, false)
check(
  'the Startup folder, which would run it at login',
  where('~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.bat').ok,
  false
)
check(
  'and the Start Menu above it',
  where('~/AppData/Roaming/Microsoft/Windows/Start Menu/x.lnk').ok,
  false
)
check('ssh keys', where('~/.ssh/authorized_keys').ok, false)
check('aws credentials', where('~/.aws/credentials').ok, false)
check('a network share', where('\\\\attacker\\share\\a.py').ok, false)
check('a reserved device name', where('~/Downloads/CON').ok, false)
check('and one with an extension', where('~/Downloads/nul.txt').ok, false)
check('a wildcard', where('~/Downloads/*.py').ok, false)
check('no path at all', where('   ').ok, false)
check('a folder, with no file on the end', where('~/Downloads/..').ok, false)

// Climbing out and back in is not an escape, so it is not refused.
check('a path that comes back inside is fine', where('~/Downloads/../Documents/a.py').ok, true)

for (const [what, path] of [
  ['home itself', '~/Downloads/../../../Windows/System32/x.dll'],
  ['Startup', '~/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.bat']
]) {
  check(`${what} refusal explains itself`, Boolean(where(path).why), true)
}

/* ------------------------------------------------------------------ the wiring */

const main = readFileSync('src/main/writefile.ts', 'utf8')
check('the writer vets the path itself', /checkWritePath\(/.test(main), true)
check('and refuses rather than trusting the caller', /if \(!check\.ok\)/.test(main), true)
check('the size ceiling is enforced', /MAX_BYTES/.test(main), true)
// A file written as UTF-16 or with a BOM is not what a Python interpreter wants.
check('written as plain utf-8', /'utf8'/.test(main), true)

/* ------------------------------ a refusal that can be acted on ----------- */

/**
 * The Startup refusal used to say only "That folder makes files run by
 * themselves or holds credentials" - true, and no help to anyone. Asked to
 * open Notepad at login, the model proposed a write into
 * Start Menu/Programs/Startup two times in three even after the prompt was
 * told not to, so the refusal is the message that actually gets read. It
 * now names the thing that would have worked.
 */
{
  // The same env the checks above use, so the two agree about home.
  const home = env.home
  const startup = `${home}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.bat`
  const refusal = where(startup)
  check('a Startup write is refused', refusal.ok, false)
  check(
    'and the reason says it runs at login',
    /run by themselves at every login/.test(refusal.why),
    true
  )
  check('and names what would have worked', /scheduled task/i.test(refusal.why), true)

  // A different protected folder gets the general message, not the
  // login-specific one, because telling someone about scheduled tasks when
  // they tried to write into .ssh would be nonsense.
  const ssh = where(`${home}/.ssh/id_rsa`)
  check('an .ssh write is refused too', ssh.ok, false)
  check('with its own reason', /scheduled task/i.test(ssh.why), false)
  check('that still says where to go instead', /home folder/i.test(ssh.why), true)
}

const prompt = W.WRITE_PROMPT
check(
  'the model is told not to use a shell for this',
  /never use a shell command/i.test(prompt),
  true
)
check('New-Item is named, since that is what it reached for', /New-Item/.test(prompt), true)
check('and how to run a python file', /python "<full path>"/.test(prompt), true)

const tiers = readFileSync('src/shared/assistant.ts', 'utf8')
check('the prompt is actually included', /WRITE_PROMPT/.test(tiers), true)

console.log(`\n${failed === 0 ? 'all' : `${failed} FAILED of`} write-file checks`)
process.exit(failed === 0 ? 0 : 1)
