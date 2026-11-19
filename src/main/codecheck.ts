import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PY_CHECK, codeVerdictText, langOfPath, librariesFor, unsafeInclude, type CodeLang, type CodeVerdict } from '@shared/codecheck'
import { FAKE_TK, FAKE_TK_FONT, FAKE_TK_MESSAGEBOX, tkVerdict } from '@shared/faketk'
import { mkdirSync } from 'node:fs'

/**
 * Checks a program without running it: see shared/codecheck.ts.
 *
 *   Python      parsed, every name checked, every import looked up
 *   C / C++     compiled and linked, every warning on, into a folder that
 *               is deleted after - the program itself is never started
 *   JavaScript  `--check`, by the Node inside Wumpy
 *   bash        `bash -n`
 *
 * With whatever compiler or Python the computer has: none is shipped. One
 * that is not there is said to be not there, which an agent reports as not
 * checked rather than as fine.
 */

interface Ran {
  code: number | null
  out: string
  /** The program is not on this computer. */
  absent: boolean
  timedOut: boolean
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve) => {
    let out = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: null, out: '', absent: true, timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const take = (d: Buffer): void => {
      if (out.length < 200_000) out += d.toString('utf8')
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ code: null, out, absent: e.code === 'ENOENT', timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      /* Windows' "python" with no Python is a stub that offers the Store. */
      const stub = code === 9009 || /was not found; run without arguments to install from the Microsoft Store/i.test(out)
      resolve({ code, out, absent: stub, timedOut })
    })
  })
}

/** The first of these that is on this computer, found once. */
const found = new Map<string, { cmd: string; pre: string[]; version: string } | null>()
async function first(kind: string, candidates: Array<[string, string[]]>, cwd: string): Promise<{ cmd: string; pre: string[]; version: string } | null> {
  if (found.has(kind)) return found.get(kind) ?? null
  for (const [cmd, pre] of candidates) {
    const r = await run(cmd, [...pre, '--version'], cwd, 15_000)
    if (!r.absent && r.code === 0) {
      const version = r.out.split('\n')[0].trim().slice(0, 80)
      const pick = { cmd, pre, version }
      found.set(kind, pick)
      return pick
    }
  }
  found.set(kind, null)
  return null
}

const win = process.platform === 'win32'

/** Compiler output, cut to the errors and the lines that explain them. */
function compilerErrors(out: string, file: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const lines = out.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(new RegExp(`^.*?${file.replace('.', '\\.')}:`), 'line ')
    if (/\berror\b:|undefined reference|ld returned|fatal error/i.test(lines[i])) {
      const said = l.trim().slice(0, 300)
      if (!errors.includes(said)) errors.push(said)
    } else if (/\bwarning\b:/i.test(lines[i])) {
      const said = l.trim().slice(0, 200)
      if (!warnings.includes(said)) warnings.push(said)
    }
  }
  return { errors: errors.slice(0, 12), warnings: warnings.slice(0, 6) }
}

export async function checkCode(code: string, lang: CodeLang): Promise<CodeVerdict> {
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-code-'))
  try {
    if (lang === 'python') {
      const py = await first('python', win ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]], dir)
      if (!py) return { ran: false, ok: false, errors: [], missing: [], how: 'there is no Python on this computer to check it with.' }
      writeFileSync(join(dir, 'main.py'), code)
      const r = await run(py.cmd, [...py.pre, '-I', '-c', PY_CHECK, join(dir, 'main.py')], dir, 30_000)
      const lines = r.out.split(/\r?\n/)
      const errors = lines.filter((l) => l.startsWith('ERROR: ')).map((l) => l.slice(7))
      const missing = lines.filter((l) => l.startsWith('MISSING: ')).map((l) => l.slice(9))
      const has = lines.find((l) => l.startsWith('HAS: '))?.slice(5).trim()
      const version = lines.find((l) => l.startsWith('PYTHON: '))?.slice(8).trim() ?? py.version
      if (r.timedOut || (!lines.some((l) => l.startsWith('PYTHON: ')) && !errors.length)) {
        return { ran: false, ok: false, errors: [], missing: [], how: `Python did not finish checking it: ${r.out.trim().slice(0, 300) || 'no output'}` }
      }
      return { ran: true, ok: errors.length === 0, errors, missing, has, how: `Checked it with Python ${version}, without running it.` }
    }
    if (lang === 'cpp' || lang === 'c') {
      const unsafe = unsafeInclude(code)
      if (unsafe) return { ran: false, ok: false, errors: [], missing: [], how: `this include reaches outside the program, so it is not compiled: ${unsafe}` }
      const cc =
        lang === 'cpp'
          ? await first('c++', [['g++', []], ['clang++', []], ['c++', []]], dir)
          : await first('c', [['gcc', []], ['clang', []], ['cc', []]], dir)
      if (!cc) return { ran: false, ok: false, errors: [], missing: [], how: `there is no ${lang === 'cpp' ? 'C++' : 'C'} compiler on this computer (g++ or clang).` }
      const file = lang === 'cpp' ? 'main.cpp' : 'main.c'
      writeFileSync(join(dir, file), code)
      const std = lang === 'cpp' ? '-std=c++17' : '-std=c11'
      const libs = librariesFor(code, process.platform)
      const r = await run(cc.cmd, [...cc.pre, std, '-Wall', '-Wextra', '-O1', file, '-o', win ? 'main.exe' : 'main', ...libs], dir, 90_000)
      if (r.timedOut) return { ran: false, ok: false, errors: [], missing: [], how: 'the compiler took over a minute and a half, so it was stopped.' }
      const { errors, warnings } = compilerErrors(r.out, file)
      /* A header that is not there is a library that is not installed. */
      const missing = errors.filter((e) => /fatal error: .*No such file or directory|cannot find -l/i.test(e))
      const real = errors.filter((e) => !missing.includes(e))
      if (r.code !== 0 && !errors.length) real.push(r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `the compiler failed (exit ${r.code})`)
      const how = `Compiled and linked it with ${cc.version.split(' (')[0]} (${std.slice(5)}, -Wall -Wextra${libs.length ? `, ${libs.join(' ')}` : ''}) - it was not run.${
        warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join('\n')}` : ''
      }`
      return { ran: true, ok: r.code === 0, errors: real, missing, how }
    }
    if (lang === 'javascript') {
      const file = /^\s*(?:import|export)\s/m.test(code) ? 'main.mjs' : 'main.js'
      writeFileSync(join(dir, file), code)
      const r = await run(process.execPath, ['--check', file], dir, 20_000, { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
      const errors = r.code === 0 ? [] : [r.out.trim().split('\n').filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v/.test(l)).slice(0, 6).join(' / ').replace(/^.*?main\.m?js:/, 'line ')]
      return { ran: true, ok: r.code === 0, errors, missing: [], how: 'Checked its syntax with Node, without running it.' }
    }
    const bash = win ? null : await first('bash', [['bash', []]], dir)
    if (!bash) return { ran: false, ok: false, errors: [], missing: [], how: 'there is no bash here to check it with.' }
    writeFileSync(join(dir, 'main.sh'), code)
    const r = await run(bash.cmd, ['-n', 'main.sh'], dir, 15_000)
    const errors = r.code === 0 ? [] : r.out.trim().split('\n').slice(0, 6).map((l) => l.replace(/^main\.sh: /, ''))
    return { ran: true, ok: r.code === 0, errors, missing: [], how: 'Checked its syntax with bash -n, without running it.' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** For an agent: the check, said as its tool's output. */
export async function checkCodeText(code: string, lang: CodeLang): Promise<{ ran: boolean; ok: boolean; output: string; missing: string[] }> {
  const v = await checkCode(code, lang)
  return { ran: v.ran, ok: v.ok, output: codeVerdictText(lang, v), missing: v.missing }
}

/** A file the chat just wrote, when it is a program this can check. */
export async function checkCodeFile(path: string): Promise<{ lang: CodeLang; verdict: CodeVerdict } | null> {
  const lang = langOfPath(path)
  if (!lang) return null
  let code: string
  try {
    code = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  return { lang, verdict: await checkCode(code, lang) }
}

/* ------------------------------------------------------------ running */

const CSI_CLEAR = '\x1b[2J'
/* A line that says the game is over - not "r: restart (game over)" in a
   list of controls. */
const OVER_LINE = /^[^a-z0-9]*(?:game\s*over|you\s+(?:lose|lost|died)|final score)/im

/** A program a player plays in a terminal or a window: worth running. */
export function isInteractive(code: string): boolean {
  return /\b(?:curses|ncurses|termios|conio|getch|kbhit|pygame|tkinter|tcsetattr|SDL_|raylib|keyboard\.is_pressed)\b/.test(code)
}

/** What the terminal showed last: after its last clear, without escapes. */
export function lastScreen(raw: string): string {
  const cut = raw.lastIndexOf(CSI_CLEAR)
  const tail = cut >= 0 ? raw.slice(cut + CSI_CLEAR.length) : raw.slice(-4000)
  return tail
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (m) => (/^\x1b\[\d*;?\d*H$/.test(m) ? '\n' : ''))
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>78]|\x1bO./g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(-16)
    .join('\n')
}

/**
 * Runs a terminal program the way a player would, out of sight, and says
 * what happened: Linux only, inside bubblewrap - no network, no home folder,
 * the system read-only, its own folder the only place it can write, and all
 * of it killed after six seconds. Space and Enter, then the arrows, are
 * pressed; once it says the game is over, nothing more is.
 *
 * "write a snake game in C++ that i can play in the terminal" came back
 * compiling clean, reviewed three times, and quitting by itself the moment
 * the game was over - its "Press Y to play again" waited on a loop that
 * never ran. Only running it shows that.
 *
 * Null when it cannot be run here: not Linux, no bubblewrap, a window
 * (tkinter) rather than a terminal, or not a program this runs.
 */
export async function runProgram(code: string, lang: CodeLang): Promise<{ ok: boolean; output: string } | null> {
  if (process.platform !== 'linux' || (lang !== 'python' && lang !== 'cpp' && lang !== 'c')) return null
  /* A window rather than a terminal: played through a stand-in tkinter. */
  const tk = lang === 'python' && /^\s*(?:import\s+tkinter|from\s+tkinter\b)/m.test(code) && !/^\s*(?:import\s+(?:curses|pygame)|from\s+(?:curses|pygame)\b)/m.test(code)
  const tools = ['/usr/bin/bwrap', '/usr/bin/script', ...(lang === 'python' ? ['/usr/bin/python3'] : [])]
  if (!tools.every((t) => existsSync(t))) return null
  const dir = mkdtempSync(join(tmpdir(), 'wumpy-run-'))
  try {
    let program: string
    if (tk) {
      writeFileSync(join(dir, 'main.py'), code)
      mkdirSync(join(dir, 'faketk', 'tkinter'), { recursive: true })
      writeFileSync(join(dir, 'faketk', 'tkinter', '__init__.py'), FAKE_TK)
      writeFileSync(join(dir, 'faketk', 'tkinter', 'messagebox.py'), FAKE_TK_MESSAGEBOX)
      writeFileSync(join(dir, 'faketk', 'tkinter', 'font.py'), FAKE_TK_FONT)
      writeFileSync(
        join(dir, 'faketk', 'tkinter', 'ttk.py'),
        'from tkinter import *\nclass Style:\n    def __init__(self, *a, **k): pass\n    def configure(self, *a, **k): pass\n    def theme_use(self, *a): pass\nCombobox = Entry\nProgressbar = Frame\n'
      )
      return await playTk(dir)
    }
    if (lang === 'python') {
      writeFileSync(join(dir, 'main.py'), code)
      program = 'python3 -I main.py'
    } else {
      if (unsafeInclude(code)) return null
      const cc = lang === 'cpp' ? await first('c++', [['g++', []], ['clang++', []], ['c++', []]], dir) : await first('c', [['gcc', []], ['clang', []], ['cc', []]], dir)
      if (!cc) return null
      const file = lang === 'cpp' ? 'main.cpp' : 'main.c'
      writeFileSync(join(dir, file), code)
      /*
       * With the sanitizers, so a bad index or a read past an array stops
       * the program at the line that did it, every time. A Snake placed its
       * food outside the board now and then: it passed four runs, and
       * crashed on the fifth, after it had been saved.
       */
      const std = lang === 'cpp' ? '-std=c++17' : '-std=c11'
      const libs = librariesFor(code, 'linux')
      let built = await run(cc.cmd, [...cc.pre, std, '-g', '-O1', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', file, '-o', 'main', ...libs], dir, 90_000)
      if (built.code !== 0) built = await run(cc.cmd, [...cc.pre, std, '-O1', file, '-o', 'main', ...libs], dir, 90_000)
      if (built.code !== 0) return null
      program = './main'
    }
    const args = [
      ...sandbox(dir),
      '/usr/bin/script', '-qfec', `stty rows 30 cols 90 2>/dev/null; exec ${program}`, '/dev/null'
    ]
    return await new Promise((resolve) => {
      const started = Date.now()
      const child = spawn('/usr/bin/bwrap', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let raw = ''
      let exited: { code: number | null; signal: string | null; at: number } | null = null
      let overAt = 0
      const pressed: string[] = []
      const take = (d: Buffer): void => {
        if (raw.length < 400_000) raw += d.toString('utf8')
        if (!overAt && OVER_LINE.test(lastScreen(raw))) overAt = Date.now()
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      /* Arrows as a real terminal sends them: SS3 once the program has
         asked for application keys (curses does), CSI otherwise. */
      const arrow = (c: string): string => (raw.includes('\x1b[?1h') ? `\x1bO${c}` : `\x1b[${c}`)
      const keys: Array<[number, string, string]> = [
        [1000, ' ', 'Space'],
        [1300, '\r', 'Enter'],
        [1900, 'B', 'down'],
        [2500, 'D', 'left'],
        [3100, 'A', 'up'],
        [3700, 'C', 'right'],
        [4300, 'B', 'down']
      ]
      const timers = keys.map(([at, key, name]) =>
        setTimeout(() => {
          if (exited || overAt) return
          try {
            child.stdin.write(/^[A-D]$/.test(key) ? arrow(key) : key)
            pressed.push(name)
          } catch {
            /* gone */
          }
        }, at)
      )
      const finish = (): void => {
        timers.forEach(clearTimeout)
        const screen = lastScreen(raw)
        const secs = (ms: number): string => (ms / 1000).toFixed(1)
        const said = `${pressed.length ? `It was sent ${pressed.join(', ')}.` : 'No key was pressed.'}${screen ? `\nIts screen at the end:\n${screen}` : ''}`
        /* What a sanitizer said, wherever it scrolled to: the line that broke. */
        const plain = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
        const sanitizer = plain
          .split('\n')
          .filter((l) => /runtime error:|ERROR: AddressSanitizer|SUMMARY: (?:Address|Undefined)|^\s*#\d+ .* main\.c(?:pp)?:\d+/.test(l))
          .slice(0, 6)
          .map((l) => l.trim().replace(/^\/work\//, ''))
        const crashed = sanitizer.length > 0 || /Traceback \(most recent call last\)|Segmentation fault|core dumped|terminate called after/.test(screen)
        if (sanitizer.length) {
          timers.forEach(clearTimeout)
          resolve({ ok: false, output: `Ran it out of sight, in a sandbox, with the memory checks on: it broke.\n${sanitizer.join('\n')}\n${pressed.length ? `It was sent ${pressed.join(', ')}.` : 'No key was pressed.'}` })
          return
        }
        /* Keys echoed back as text - ^[[B - are the terminal's, not the
           program's: one that shows nothing else never drew at all. A
           Snake read the keyboard before it had set the terminal up, and
           that read waited for ever. */
        const echoed = /\^\[(?:\[|O)[A-D]/.test(screen)
        const own = screen.replace(/\^\[(?:\[|O)[A-D]/g, '').trim()
        if ((!exited || timedOut) && !own) {
          resolve({
            ok: false,
            output: `Ran it out of sight for 6 seconds, in a sandbox: it drew nothing at all${echoed ? ', and the keys pressed came back as text (^[[B), so the terminal was never switched to raw input' : ''}. It is stuck before its first frame - a read of the keyboard that waits, most likely, before the terminal is set up. ${said}`
          })
          return
        }
        if (!exited || timedOut) {
          resolve({ ok: !crashed, output: `Ran it out of sight for 6 seconds, in a sandbox: it was still running.${crashed ? ' But its screen shows an error.' : ''} ${said}` })
          return
        }
        const when = secs(exited.at - started)
        const how = exited.signal ? `killed by ${exited.signal}` : `exit code ${exited.code}`
        if (exited.code !== 0 || exited.signal || crashed) {
          resolve({ ok: false, output: `Ran it out of sight, in a sandbox: it crashed ${when} seconds in (${how}). ${said}` })
          return
        }
        resolve({
          ok: false,
          output: overAt
            ? `Ran it out of sight, in a sandbox: it said the game was over, and then quit by itself ${secs(exited.at - overAt)} seconds later, with no key pressed - the restart it offers never came. ${said}`
            : `Ran it out of sight, in a sandbox: it quit by itself ${when} seconds in (${how}). ${said}`
        })
      }
      child.on('exit', (code, signal) => {
        if (!exited) exited = { code, signal, at: Date.now() }
      })
      child.on('close', () => {
        clearTimeout(killer)
        finish()
      })
      let timedOut = false
      const killer = setTimeout(() => {
        timedOut = !exited
        child.kill('SIGKILL')
      }, 6000)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** bubblewrap's walls: see runProgram. */
function sandbox(dir: string, env: Record<string, string> = {}): string[] {
  return [
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/bin', '/sbin',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', dir, '/work',
    '--chdir', '/work',
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop', 'ALL',
    '--clearenv',
    '--setenv', 'TERM', 'xterm-256color',
    '--setenv', 'PATH', '/usr/bin',
    '--setenv', 'HOME', '/work',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'SDL_VIDEODRIVER', 'dummy',
    '--setenv', 'SDL_AUDIODRIVER', 'dummy',
    '--setenv', 'ASAN_OPTIONS', 'detect_leaks=0',
    '--setenv', 'UBSAN_OPTIONS', 'print_stacktrace=1:halt_on_error=1',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, v])
  ]
}

/**
 * A tkinter game, played through the stand-in (shared/faketk.ts) on its own
 * clock, in the same sandbox: minutes of play in a second or two.
 */
async function playTk(dir: string): Promise<{ ok: boolean; output: string }> {
  const r = await run('/usr/bin/bwrap', [...sandbox(dir, { PYTHONPATH: '/work/faketk' }), '/usr/bin/python3', '-s', 'main.py'], dir, 20_000)
  const out = r.out
  if (/Traceback \(most recent call last\)/.test(out)) {
    const tail = out.slice(out.lastIndexOf('Traceback')).split('\n').slice(-8).join('\n')
    /* Where it broke: in the game, or in the stand-in - which is this
       test's fault, never the game's. A Frame without pack_propagate sent
       an agent rewriting a working Tetris three times. */
    const frames = [...tail.matchAll(/File "([^"]+)"/g)].map((m) => m[1])
    if (frames.length && frames[frames.length - 1].includes('/faketk/')) {
      return { ok: true, output: 'Ran it out of sight with a stand-in for tkinter, which could not follow everything it does - so it is not known whether it plays. Nothing wrong was found.' }
    }
    return { ok: false, output: `Ran it out of sight, in a sandbox, with a stand-in for tkinter: it crashed.\n${tail}` }
  }
  if (r.timedOut) return { ok: false, output: 'Ran it out of sight with a stand-in for tkinter: it did not finish in 20 seconds - an endless loop outside after(), most likely.' }
  if (!/^END$/m.test(out)) return { ok: false, output: `Ran it out of sight with a stand-in for tkinter: it ended before its window's loop was run (exit code ${r.code}).${out.trim() ? `\n${out.trim().split('\n').slice(-6).join('\n')}` : ''}` }
  const v = tkVerdict(out)
  return { ok: v.ok, output: `Ran it out of sight, in a sandbox, with a stand-in for tkinter on its own clock. ${v.line}` }
}
