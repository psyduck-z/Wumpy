/**
 * Code that is not a web page, checked the way pages are: see
 * main/codecheck.ts. These are the pure parts - which language a block or a
 * file is, the Python checker's script, the libraries a C++ game links -
 * so they can be checked without a compiler.
 *
 * "make sure to test its other languages too, not just HTML, for example
 * CPP ... a Tetris in Python". A page is loaded and played; a program in
 * another language is compiled, or parsed and read for names it never
 * defined - the "car is not defined" that crashed the first Crossy Road -
 * and for modules that are not installed. It is never run: unlike a page,
 * it would run with all of the user's rights.
 */

export type CodeLang = 'python' | 'cpp' | 'c' | 'javascript' | 'bash'

const TAGS: Record<string, CodeLang> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'c',
  javascript: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  node: 'javascript',
  bash: 'bash',
  sh: 'bash'
}

const EXTENSIONS: Record<string, CodeLang> = {
  py: 'python',
  pyw: 'python',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'c',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  bash: 'bash'
}

export function langOfPath(path: string): CodeLang | null {
  const ext = /\.([a-z0-9+]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? (EXTENSIONS[ext] ?? null) : null
}

export const LANG_NAME: Record<CodeLang, string> = {
  python: 'Python',
  cpp: 'C++',
  c: 'C',
  javascript: 'JavaScript',
  bash: 'shell script'
}

/**
 * The program in a report: the longest fenced block in a language that can
 * be checked. A one-line `python3 tetris.py` beside the program is how to
 * run it, not the program, so a block needs a few lines to count.
 */
export function codeIn(report: string): { lang: CodeLang; code: string } | null {
  const lines = report.split('\n')
  let best: { lang: CodeLang; code: string } | null = null
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,})[ \t]*([\w+#.-]*)/.exec(lines[i])
    if (!open) continue
    const fence = open[1]
    const lang = TAGS[open[2].toLowerCase()]
    let j = i + 1
    while (j < lines.length && !new RegExp(`^\\s{0,3}${fence}\`*\\s*$`).test(lines[j])) j++
    const body = lines.slice(i + 1, j).join('\n')
    if (lang && body.split('\n').length >= (lang === 'bash' ? 10 : 6) && (!best || body.length > best.code.length)) best = { lang, code: body }
    i = j
  }
  return best
}

/**
 * An #include the compiler must not follow: one that names a file outside
 * the program - by an absolute path, a drive, or a climb with `..` - or one
 * worked out by a macro. A compiler's error quotes what it included, and an
 * agent is not to read keys or passwords by any door.
 */
export function unsafeInclude(code: string): string | null {
  for (const line of code.split('\n')) {
    const m = /^\s*#\s*(include|include_next|import|embed|pragma\s+GCC\s+dependency)\b\s*(.*)$/.exec(line)
    if (!m) continue
    const target = /^[<"]([^>"]*)[>"]/.exec(m[2].trim())?.[1]
    if (target === undefined) return line.trim()
    if (/^[\\/~]|^[a-z]:|\.\./i.test(target) || /^embed$|dependency/.test(m[1])) return line.trim()
  }
  return null
}

/** What a C or C++ program links, from what it includes. */
export function librariesFor(code: string, platform: string): string[] {
  const has = (re: RegExp): boolean => re.test(code)
  const libs: string[] = []
  if (has(/#\s*include\s*[<"](?:ncursesw?\/)?n?curses(?:w)?\.h[>"]/)) libs.push(platform === 'win32' ? '-lpdcurses' : '-lncursesw')
  if (has(/#\s*include\s*[<"]SDL2\/SDL\.h[>"]|#\s*include\s*[<"]SDL\.h[>"]/)) libs.push('-lSDL2')
  if (has(/#\s*include\s*[<"]SFML\//)) libs.push('-lsfml-graphics', '-lsfml-window', '-lsfml-system')
  if (has(/#\s*include\s*[<"]raylib\.h[>"]/)) libs.push('-lraylib')
  if (has(/#\s*include\s*[<"](?:GL\/gl|GLFW\/glfw3)\.h[>"]/)) libs.push('-lGL', '-lglfw')
  if (has(/#\s*include\s*<(?:thread|pthread\.h|future|mutex)>/)) libs.push('-pthread')
  if (has(/#\s*include\s*<(?:math\.h|cmath)>/)) libs.push('-lm')
  if (platform === 'win32' && has(/#\s*include\s*<windows\.h>/)) libs.push('-lgdi32', '-luser32')
  return libs
}

/**
 * Run as `python -I -c PY_CHECK main.py`. Parses the program, never runs
 * it: a syntax error; every name it reads that nothing defines - in any
 * function, as Python would only find out when that line ran; every module
 * it imports that is not installed. And what a game could be drawn with
 * here, so a program is written for the Python it will run on.
 *
 * Lines out: "ERROR: ...", "MISSING: ...", "HAS: ...", "PYTHON: 3.14.0".
 */
export const PY_CHECK = String.raw`
import ast, builtins, importlib.util, symtable, sys
print("PYTHON: " + sys.version.split()[0])
src = open(sys.argv[1], encoding="utf-8").read()
try:
    tree = ast.parse(src, "main.py")
    compile(tree, "main.py", "exec")
except SyntaxError as e:
    print("ERROR: SyntaxError: %s (line %s)" % (e.msg, e.lineno))
    sys.exit(0)
star = any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree))
known = set(dir(builtins)) | {"__name__", "__file__", "__doc__", "__builtins__", "__spec__", "__loader__", "__package__", "__annotations__", "__dict__", "__module__", "__qualname__", "__class__"}
top = symtable.symtable(src, "main.py", "exec")
defined = set()
for s in top.get_symbols():
    if s.is_assigned() or s.is_imported() or s.is_namespace():
        defined.add(s.get_name())
def gather(t):
    for s in t.get_symbols():
        if s.is_declared_global() and s.is_assigned():
            defined.add(s.get_name())
    for c in t.get_children():
        gather(c)
gather(top)
missing = set()
def walk(t):
    for s in t.get_symbols():
        if not s.is_referenced():
            continue
        n = s.get_name()
        local = t.get_type() != "module" and (s.is_local() or s.is_free() or s.is_parameter())
        if t.get_type() == "class" and (s.is_assigned() or s.is_imported() or s.is_namespace()):
            local = True
        if not local and n not in defined and n not in known:
            missing.add(n)
    for c in t.get_children():
        walk(c)
if not star:
    walk(top)
if missing:
    lines = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and n.id in missing and isinstance(n.ctx, ast.Load):
            lines.setdefault(n.id, n.lineno)
    for name in sorted(missing, key=lambda x: lines.get(x, 0)):
        print("ERROR: NameError: name '%s' is used but never defined (line %s)" % (name, lines.get(name, "?")))
optional = set()
for t in ast.walk(tree):
    if isinstance(t, ast.Try) and any(h.type is None or any(isinstance(x, ast.Name) and x.id in ("ImportError", "ModuleNotFoundError", "Exception") for x in ([h.type] if not isinstance(h.type, ast.Tuple) else h.type.elts)) for h in t.handlers):
        for b in t.body:
            for n in ast.walk(b):
                if isinstance(n, (ast.Import, ast.ImportFrom)):
                    optional.add(n.lineno)
mods = []
for n in ast.walk(tree):
    if getattr(n, "lineno", None) in optional and isinstance(n, (ast.Import, ast.ImportFrom)):
        continue
    if isinstance(n, ast.Import):
        mods += [(a.name.split(".")[0], n.lineno) for a in n.names]
    elif isinstance(n, ast.ImportFrom) and n.module and not n.level:
        mods.append((n.module.split(".")[0], n.lineno))
def loads(name):
    try:
        if importlib.util.find_spec(name) is None:
            return "not installed"
    except Exception as e:
        return "not installed (%s)" % e
    probe = {"tkinter": "_tkinter", "curses": "_curses"}.get(name)
    if probe:
        try:
            __import__(probe)
        except Exception as e:
            return "installed but cannot load here (%s)" % str(e).splitlines()[0][:120]
    return None
seen = set()
for name, line in mods:
    if name in seen or name == "__future__":
        continue
    seen.add(name)
    why = loads(name)
    if why:
        print("MISSING: %s is %s (imported at line %s)" % (name, why, line))
print("HAS: " + ", ".join(m for m in ("tkinter", "pygame", "curses", "pyglet", "arcade") if not loads(m)))
`

export interface CodeVerdict {
  /** Whether a checker ran at all. */
  ran: boolean
  /** No errors. A missing module is not an error in the code. */
  ok: boolean
  errors: string[]
  /** Modules or libraries not installed here. */
  missing: string[]
  /** "Compiled it with g++ 15.2 ...": what was done. */
  how: string
  /** What a Python game could use here: "tkinter, curses". */
  has?: string
}

/** Said to an agent, as a tool's output. */
export function codeVerdictText(lang: CodeLang, v: CodeVerdict): string {
  if (!v.ran) return `NOT RUN: ${v.how}`
  const parts = [v.how]
  if (v.errors.length) parts.push(`${v.errors.length === 1 ? 'One error' : `${v.errors.length} errors`}:`, ...v.errors.map((e) => `- ${e}`))
  else if (!v.ok) parts.push('It stopped at what is not installed, so the rest of it is not checked.')
  else parts.push(lang === 'python' ? 'It parses, and every name it uses is defined.' : 'No errors.')
  if (v.missing.length) {
    parts.push(
      `Missing here: ${v.missing.join('; ')}.`,
      'If the brief named that library, keep it and give the exact install command in your report; otherwise use one that is installed' +
        (v.has !== undefined ? ` - this Python has: ${v.has || 'none of tkinter, pygame, curses'}.` : '.')
    )
  } else if (lang === 'python' && v.has !== undefined) parts.push(`This Python can draw with: ${v.has || 'none of tkinter, pygame, curses'}.`)
  parts.push('It was not run: that rules out what a compiler catches, not wrong behaviour - play it in your head too.')
  return parts.join('\n')
}

/** The hand-back for a file the chat wrote, like pageErrorText. */
export function codeErrorText(path: string, lang: CodeLang, errors: readonly string[], context = ''): string {
  return [
    `Wumpy checked ${path} (${LANG_NAME[lang]}) without running it, and found:`,
    ...errors.map((e) => `- ${e}`),
    ...(context ? ['', 'Where, in the file as written:', context] : []),
    '',
    'That is a bug in the file you wrote. Find the cause in the code - the file is what you wrote above; a command reads it if you need it again - fix it and anything else wrong you see on the way, and write the whole file again. Do not tell the user it works until it checks clean. This was sent by Wumpy, not typed by the user.'
  ].join('\n')
}
