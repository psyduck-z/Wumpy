/**
 * Runs the folder commands the prompt tells the model to use, and proves the
 * ones it forbids really are wrong.
 *
 * Written because the model guessed. Asked to move screenshots into folders
 * by month it wrote `$env:USERPROFILE\Pictures\Screenshots`, which does not
 * exist on this machine: Documents, Pictures and Desktop are redirected to
 * OneDrive, so the real path is `C:\Users\<name>\OneDrive\Pictures`. The
 * guessed path fails in the most misleading way available - it reads as an
 * empty folder rather than a wrong one, so the honest answer "you have no
 * screenshots" is indistinguishable from "I looked in the wrong place".
 *
 * Every command here is extracted from SHELL_PROMPT rather than copied into
 * this file. A copy drifts; an extract cannot. If a line is reworded the
 * extraction fails loudly, which is the intended behaviour - the prompt is
 * the thing being tested.
 *
 * Run with: npm run check:paths
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const NL = String.fromCharCode(10)
const out = join(process.cwd(), '.paths-check.mjs')
await build({
  entryPoints: ['src/shared/assistant.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error'
})
const T = await import(pathToFileURL(out).href)
rmSync(out, { force: true })

const PROMPT = T.SHELL_PROMPT
const VOICE = T.VOICE_PROMPT

function run(command) {
  return new Promise((resolve) => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    setTimeout(() => {
      try {
        p.kill()
      } catch {}
      resolve({ code: -1, stdout, stderr: 'timed out' })
    }, 20_000)
  })
}

let failed = 0
let count = 0
function check(name, ok, detail = '') {
  count++
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(52)} ${detail}`)
}

/* ------------------------------------- the calls the prompt tells it to use */

/**
 * Pulled out of the prompt by pattern, so the list cannot fall behind it.
 * If the prompt stops naming any, that is a failure too: the rule would
 * have become advice with no commands behind it.
 */
const FOLDER_CALLS = [...PROMPT.matchAll(/\[Environment\]::GetFolderPath\("(\w+)"\)/g)].map(
  (m) => m[1]
)
check('the prompt names folder lookups', FOLDER_CALLS.length >= 3, FOLDER_CALLS.join(', '))

for (const name of FOLDER_CALLS) {
  const r = await run(
    `$p = [Environment]::GetFolderPath("${name}"); if ($p -and (Test-Path $p)) { $p } else { "MISSING:$p" }`
  )
  const ok = r.code === 0 && r.stdout.length > 0 && !r.stdout.startsWith('MISSING:')
  check(`GetFolderPath("${name}") resolves to a real folder`, ok, r.stdout.slice(0, 54))
}

/**
 * And the one the prompt singles out as the exception. Downloads has no
 * SpecialFolder name at all, so the guessed path is the correct answer
 * there - which is exactly why the rule has to name it rather than say
 * "never build these paths by hand".
 */
{
  const r = await run(
    '$p = "$env:USERPROFILE\\Downloads"; if (Test-Path $p) { $p } else { "MISSING:$p" }'
  )
  check(
    'Downloads really is the exception',
    r.code === 0 && !r.stdout.startsWith('MISSING:'),
    r.stdout.slice(0, 54)
  )
  check(
    'and the prompt says so',
    /Downloads is the exception/.test(PROMPT) && /no SpecialFolder name/.test(PROMPT)
  )
}

/**
 * The claim that justifies the whole rule: the path the model reached for
 * is not there. If a future machine un-redirects Pictures this check turns
 * into a pass of a different kind - the guess would be harmless - so it
 * asserts the redirection is what makes the difference, not that the guess
 * is eternally wrong.
 */
{
  const r = await run(
    '$guess = "$env:USERPROFILE\\Pictures"; ' +
      '$real = [Environment]::GetFolderPath("MyPictures"); ' +
      '"$([bool](Test-Path $guess))|$([bool](Test-Path $real))|$real"'
  )
  const [guessed, real, path] = r.stdout.split('|')
  const redirected = real === 'True' && !String(path).startsWith(process.env.USERPROFILE + '\\P')
  check('the real Pictures folder is found either way', real === 'True', String(path).slice(0, 54))
  // Only meaningful while the folder is redirected, which it is here.
  if (redirected) {
    check(
      'and the guessed path is the one that fails',
      guessed === 'False',
      `guess exists: ${guessed}`
    )
  } else {
    console.log('ok   Pictures is not redirected on this machine; guess would work')
    count++
  }
}

/* ----------------------------------------- the mistake the prompt forbids */

/**
 * -Filter with two patterns. The model wrote this three times out of four,
 * and it is not a filter that matches neither - it is a hard parameter
 * binding error, so the whole command dies.
 */
{
  const r = await run('Get-ChildItem -Path $env:USERPROFILE -Filter "*.png", "*.jpg"')
  const bound = /Cannot convert/i.test(r.stderr) && /System\.String/i.test(r.stderr)
  check('-Filter with a list really is an error', bound, r.stderr.split(NL)[0]?.slice(0, 48) ?? '')
  check(
    'and the prompt says exactly that',
    /-Filter TAKES ONE PATTERN/.test(PROMPT) && /System\.Object\[\]/.test(PROMPT)
  )
}

/**
 * The alternative the prompt offers, taken from the prompt and run. An
 * instruction to use something that does not work is worse than no
 * instruction, and this one has a trap next to it: -Include is silently
 * empty without -Recurse, which is why the prompt recommends Where-Object.
 */
{
  const line = PROMPT.split(NL).find((l) => /Where-Object .*Extension -in/.test(l))
  check('the prompt offers a working alternative', Boolean(line), (line ?? '').trim().slice(0, 50))
  if (line) {
    // Bounded on purpose: the prompt's line is -Recurse, and pointing it at
    // the whole profile took longer than the timeout. Downloads is small and
    // is not redirected, so it proves the command runs without making the
    // check depend on how much the user happens to have.
    const command = line.trim().replace('<folder>', '"$env:USERPROFILE\Downloads"')
    const r = await run(`${command} | Measure-Object | Select-Object -ExpandProperty Count`)
    check(
      'and it runs without error',
      r.code === 0 && /^\d+$/.test(r.stdout),
      `matched ${r.stdout || r.stderr.split(NL)[0]?.slice(0, 30)}`
    )
  }
}

/**
 * The parenthesis rule, both halves run.
 *
 * The model wrote `-Path [Environment]::GetFolderPath("MyDocuments") -File`,
 * which does not fail where you would expect: the method call is not
 * evaluated, so `-File` has nothing to bind to and the whole command dies
 * having listed nothing. The prompt now shows the parenthesised form, and
 * both halves of that claim are checked here.
 */
{
  const bare = await run('Get-ChildItem -Path [Environment]::GetFolderPath("MyDocuments") -File')
  check(
    'the unparenthesised form really fails',
    /parameter cannot be found/i.test(bare.stderr),
    bare.stderr.split(NL)[0]?.slice(0, 44) ?? 'no error'
  )
  const wrapped = await run(
    'Get-ChildItem ([Environment]::GetFolderPath("MyDocuments")) -File | Measure-Object | Select-Object -ExpandProperty Count'
  )
  check(
    'and the parenthesised form works',
    wrapped.code === 0 && /^\d+$/.test(wrapped.stdout),
    wrapped.stdout || wrapped.stderr.slice(0, 40)
  )
  check('and the prompt shows the parentheses', /WRAP IT IN PARENTHESES/.test(PROMPT))
}

/* --------------------------------------- the arithmetic the prompt shows */

/**
 * The uptime line, pulled out of the prompt and run.
 *
 * Added because the model returned LastBootUpTime and then subtracted dates
 * in its head - answering 16, then 23, when the truth was 25.7. The prompt
 * now shows the command that does it exactly, so the command had better do
 * it exactly.
 */
{
  const line = VOICE.split(NL).find((l) => /TotalHours/.test(l))
  check('the prompt shows an uptime command', Boolean(line), (line ?? '').trim().slice(0, 48))
  if (line) {
    const r = await run(line.trim())
    const hours = Number(r.stdout)
    check(
      'and it returns a plausible number of hours',
      r.code === 0 && Number.isFinite(hours) && hours >= 0 && hours < 100000,
      r.stdout || r.stderr.split(NL)[0]?.slice(0, 40)
    )
  }
}

/**
 * And the bounded listing, which is the shape the no-unbounded-list rule
 * tells it to use. An instruction to write a command that does not run is
 * worse than no instruction.
 */
{
  const line = PROMPT.split(NL).find((l) => /Select-Object -First 20/.test(l))
  check('the prompt shows a bounded listing', Boolean(line), (line ?? '').trim().slice(0, 48))
  if (line) {
    // The rule is written across two lines, so the continuation is rejoined.
    const lines = PROMPT.split(NL)
    const at = lines.findIndex((l) => /Select-Object -First 20/.test(l))
    const command = `${lines[at - 1].trim()} ${lines[at].trim()}`.replace(
      '<folder>',
      '"$env:USERPROFILE\Downloads"'
    )
    const r = await run(`${command} | Measure-Object | Select-Object -ExpandProperty Count`)
    const n = Number(r.stdout)
    check(
      'and it runs and returns at most 20 rows',
      r.code === 0 && Number.isFinite(n) && n <= 20,
      r.stdout || r.stderr.split(NL)[0]?.slice(0, 44)
    )
  }
}

/* ------------------------- a command that must not be run to be checked -- */

/**
 * The login-persistence command, parsed rather than executed.
 *
 * Every other command in this file is run, because an instruction to use
 * something that does not work is worse than no instruction. This one
 * cannot be: running it would register a scheduled task on the user's
 * machine, and the whole rule here is that capability testing changes
 * nothing. PowerShell will tell us whether it is valid without doing it.
 */
{
  // WRITE_PROMPT is composed into SHELL_PROMPT, so this is the real thing
  // the model is sent rather than the constant read separately.
  const WRITE = PROMPT
  check(
    'the write prompt names the refused folders',
    /REFUSES a write into the Startup folder/.test(WRITE),
    true
  )
  check(
    'and says persistence is a command, not a write',
    /Login persistence is a COMMAND, not a write/.test(WRITE),
    true
  )

  const line = WRITE.split(NL).find((l) => /Register-ScheduledTask/.test(l))
  check('and shows one that works', Boolean(line), (line ?? '').trim().slice(0, 44))
  if (line) {
    // Parsed, never invoked. $null catches the parser's error list.
    const probe = [
      '$errors = $null',
      '$null = [System.Management.Automation.Language.Parser]::ParseInput(',
      // <name> is a placeholder in the prompt, which is right there and
      // unparseable here, so it is filled in before the parser sees it.
      `  ${JSON.stringify(line.trim().replace('<name>', 'OpenNotepadAtLogon'))}, [ref]$null, [ref]$errors)`,
      'if ($errors.Count -eq 0) { "parses" } else { "ERRORS: " + $errors[0].Message }'
    ].join(NL)
    const r = await run(probe)
    check('and it is valid PowerShell', r.stdout.trim() === 'parses', r.stdout.slice(0, 52))
  }

  // And the cmdlets it names really exist on this machine, which is a read.
  const r = await run(
    'foreach ($n in "Register-ScheduledTask","New-ScheduledTaskTrigger","New-ScheduledTaskAction") { if (Get-Command $n -ErrorAction SilentlyContinue) { "ok" } else { "MISSING $n" } }'
  )
  check(
    'and the cmdlets it names exist here',
    r.stdout.trim().split(NL).every((l) => l.trim() === 'ok'),
    r.stdout.trim().replace(/\s+/g, ' ').slice(0, 40)
  )
}

/* ------------------------------------------- find-and-change in one breath */

check(
  'the prompt forbids find-and-change',
  /NEVER FIND AND CHANGE IN THE SAME COMMAND/.test(PROMPT)
)
check('with the list-first version shown', /Right — list, and nothing else/.test(PROMPT))
check('and says a read-only pipeline may be long', /nothing in it may write/.test(PROMPT))

/* ------------------------------------- the paths handed over in the facts */

/**
 * Telling the model the rule was not enough. It followed "ask Windows" for
 * Pictures and then guessed $env:USERPROFILE\Documents on the next
 * question, which returned an empty stdout AND an empty stderr - so the
 * wrong folder was indistinguishable from an empty one. The paths are now
 * resolved once and put in the facts block, where they are something it has
 * been told rather than something it must remember to work out.
 */
const fout = join(process.cwd(), '.paths-folders.mjs')
await build({
  entryPoints: ['src/main/folders.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: fout,
  logLevel: 'error',
  external: ['electron']
})
const F = await import(pathToFileURL(fout).href)
rmSync(fout, { force: true })

const title = (key) => key[0].toUpperCase() + key.slice(1)
const resolved = await F.resolveUserFolders()

for (const [key, lookup] of [
  ['documents', 'MyDocuments'],
  ['pictures', 'MyPictures'],
  ['desktop', 'Desktop']
]) {
  const r = await run(`[Environment]::GetFolderPath("${lookup}")`)
  const windows = r.stdout.trim()
  check(
    `${key} matches what Windows says`,
    resolved[key] === windows,
    resolved[key] === windows ? resolved[key] : `${resolved[key]} != ${windows}`
  )
}

for (const [key, path] of Object.entries(resolved)) {
  if (!path) {
    // An unresolved folder is allowed, as long as it is left out rather than
    // asserted - a missing fact beats a confident wrong one.
    check(`${key} is omitted rather than guessed`, true, 'not resolved')
    continue
  }
  const r = await run(`if (Test-Path "${path}") { "yes" } else { "no" }`)
  check(`${key} is a folder that exists`, r.stdout.trim() === 'yes', path)
}

const facts = F.folderFacts(resolved)
check('the facts name every resolved folder', facts.length >= 2, `${facts.length} lines`)
for (const [key, path] of Object.entries(resolved)) {
  if (!path) continue
  check(
    `the facts carry the real ${key} path`,
    facts.some((l) => l.includes(path))
  )
}
// The warning is only earned when something really is redirected here.
const anyRedirected = Object.entries(resolved).some(
  ([key, path]) => path && path !== join(homedir(), title(key))
)
if (anyRedirected) {
  check(
    'and warn against building them by hand',
    facts[0].includes('do not build'),
    facts[0].slice(0, 60)
  )
} else {
  check('no redirect here, so no warning needed', !facts[0].includes('do not build'))
}
// Nothing may be claimed for a folder that was not resolved.
const empties = Object.entries(resolved).filter(([, p]) => !p)
check(
  'unresolved folders appear nowhere in the facts',
  empties.every(([key]) => !facts.some((l) => l.trim().startsWith(title(key)))),
  `${empties.length} unresolved`
)

console.log(`${NL}${count - failed}/${count} path checks correct`)
process.exit(failed === 0 ? 0 : 1)
