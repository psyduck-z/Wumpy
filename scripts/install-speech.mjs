/**
 * Sets up the local transcriber.
 *
 * Dictation needs Whisper, and Whisper needs Python with faster-whisper, which
 * is 300MB of dependencies and a model download. That is too much to pull in for
 * everyone who installs Wumpy, so it is opt-in and lives in its own virtual
 * environment under %LOCALAPPDATA%\Wumpy\speech - never in whatever Python
 * happens to be on PATH, where it would collide with the user's own projects.
 *
 * PyAV is pinned below 16. faster-whisper 1.2.1 asks only for `av>=11` and then
 * calls `av.open(metadata_errors=...)`, which 16 removed - so the newest PyAV
 * installs cleanly and then fails on the first clip with a TypeError.
 *
 * Run with: npm run speech:install
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOCAL = process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '.', '.local', 'share')
const HOME = join(LOCAL, 'Wumpy', 'speech')
const VENV = join(HOME, 'venv')
const PY = join(VENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

/** faster-whisper, plus the PyAV pin its own metadata is missing. */
const PACKAGES = ['faster-whisper', 'av<16']

function run(cmd, args, label) {
  process.stdout.write(`${label}… `)
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
  if (res.status !== 0) {
    console.log('failed')
    console.error((res.stderr || res.stdout || res.error?.message || '').trim().split('\n').slice(-8).join('\n'))
    process.exit(1)
  }
  console.log('done')
  return res.stdout
}

function findPython() {
  for (const candidate of [['py', ['-3', '-c', 'import sys; print(sys.executable)']], ['python', ['-c', 'import sys; print(sys.executable)']], ['python3', ['-c', 'import sys; print(sys.executable)']]]) {
    try {
      const out = execFileSync(candidate[0], candidate[1], { encoding: 'utf8', windowsHide: true }).trim()
      if (out) return out
    } catch {
      /* try the next one */
    }
  }
  return null
}

const base = findPython()
if (!base) {
  console.error('No Python found. Install Python 3.10 or newer, then run this again.')
  process.exit(1)
}
console.log(`Python:  ${base}`)
console.log(`Install: ${HOME}`)

mkdirSync(HOME, { recursive: true })
if (!existsSync(PY)) run(base, ['-m', 'venv', VENV], 'Creating the environment')
run(PY, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], 'Updating pip')
run(PY, ['-m', 'pip', 'install', '--quiet', ...PACKAGES], 'Installing faster-whisper')

// Importing it is the only proof that matters: the pip install can succeed and
// the import still fail on a mismatched binary wheel.
const check = run(
  PY,
  [
    '-I',
    '-c',
    'import faster_whisper, av, ctranslate2; print(f"faster-whisper ok, av {av.__version__}, ctranslate2 {ctranslate2.__version__}")'
  ],
  'Checking the install'
)
console.log(check.trim())

console.log(
  '\nDone. The model itself downloads on the first dictation - base.en is about\n' +
    '150MB - and is cached under the same folder. Wumpy will find this\n' +
    'environment on its own; the microphone button appears once it does.'
)
