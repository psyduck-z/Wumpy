/**
 * A tkinter that needs no screen, for playing a tkinter game out of sight:
 * see runProgram in main/codecheck.ts. Time is the game's own - `after`
 * callbacks run in order on a clock that jumps - so minutes of play take a
 * moment. Keys are pressed on that clock; what the canvas holds is counted;
 * and when nothing is left scheduled, the game's loop has stopped.
 *
 * A Python Tetris on tkinter - what a Python game is on Windows - came back
 * whose restart cleared the board and left the piece hanging for ever:
 * its gravity loop stopped at game over and nothing started it again.
 *
 * Prints, one per line: "KEY <name> <bound|unbound>", "OVER <ms>",
 * "RESTARTED <how>", "STOPPED <ms>", "MOVING <yes|no>", "END".
 */
export const FAKE_TK = String.raw`
import heapq, itertools, os, re, sys
TkVersion = 8.6
END='end'; BOTH='both'; LEFT='left'; RIGHT='right'; TOP='top'; BOTTOM='bottom'; X='x'; Y='y'
N='n'; S='s'; E='e'; W='w'; NW='nw'; NE='ne'; SW='sw'; SE='se'; CENTER='center'; HIDDEN='hidden'; NORMAL='normal'; DISABLED='disabled'; ALL='all'
class TclError(Exception): pass
_now = 0.0; _q = []; _seq = itertools.count(); _binds = {}; _canvases = []; _texts = []
# The game's clocks follow this one: a game timing its gravity by
# time.time() would otherwise never see a second pass.
import time as _time
_base = _time.time()
_time.time = lambda: _base + _now / 1000.0
_time.monotonic = lambda: 1000.0 + _now / 1000.0
_time.perf_counter = lambda: 1000.0 + _now / 1000.0
_time.time_ns = lambda: int((_base + _now / 1000.0) * 1e9)
_time.monotonic_ns = lambda: int((1000.0 + _now / 1000.0) * 1e9)
_time.sleep = lambda s: None
class _Var:
    def __init__(self, master=None, value=None, name=None): self._v = value if value is not None else self._d
    def get(self): return self._v
    def set(self, v): self._v = v
    def trace_add(self, *a): pass
class StringVar(_Var): _d = ''
class IntVar(_Var): _d = 0
class DoubleVar(_Var): _d = 0.0
class BooleanVar(_Var): _d = False
class Event: pass
class _Anything:
    # What this stand-in does not know - pack_propagate, wm_title, root.tk -
    # answers anything asked of it with nothing, rather than fail the game.
    def __call__(self, *a, **k): return None
    def __getattr__(self, name):
        if name.startswith('__'): raise AttributeError(name)
        return _Anything()
class _Tcl(_Anything):
    # root.tk.call('clock', 'milliseconds') - Tcl's own clock - is this one.
    def call(self, *a, **k):
        if len(a) >= 2 and a[0] == 'clock':
            return int(_now) if a[1] == 'milliseconds' else int(_now * 1000) if a[1] == 'microseconds' else int(_now / 1000)
        return None
    def eval(self, *a, **k): return ''
class Misc:
    def __init__(self, master=None, *a, **kw): self.master = master; self.kw = dict(kw); self.tk = _Tcl()
    def __getattr__(self, name):
        if name.startswith('__'): raise AttributeError(name)
        return _Anything()
    def pack(self, **k): pass
    def grid(self, **k): pass
    def place(self, **k): pass
    def pack_forget(self): pass
    def grid_forget(self): pass
    def config(self, **kw):
        self.kw.update(kw)
        if 'text' in kw: _texts.append(str(kw['text']))
    configure = config
    def cget(self, k): return self.kw.get(k)
    def __getitem__(self, k): return self.kw.get(k)
    def __setitem__(self, k, v): self.config(**{k: v})
    def bind(self, seq, fn=None, add=None): _binds.setdefault(seq, []).append(fn); return 'b'
    bind_all = bind
    def unbind(self, seq, funcid=None): _binds.pop(seq, None)
    def focus_set(self): pass
    focus = focus_force = focus_set
    def after(self, ms, fn=None, *args):
        if fn is None: return None
        i = next(_seq); heapq.heappush(_q, (_now + max(0, float(ms)), i, fn, args)); return 'after#%d' % i
    def after_idle(self, fn, *args): return self.after(0, fn, *args)
    def after_cancel(self, ident):
        global _q
        _q = [x for x in _q if 'after#%d' % x[1] != ident]; heapq.heapify(_q)
    def update(self): pass
    update_idletasks = update
    def winfo_width(self): return int(self.kw.get('width', 400))
    def winfo_height(self): return int(self.kw.get('height', 600))
    def winfo_exists(self): return 1
    def destroy(self): pass
    def title(self, *a): pass
    def geometry(self, *a): pass
    def resizable(self, *a): pass
    def protocol(self, *a): pass
    def quit(self): raise SystemExit(0)
    def mainloop(self, n=0): _run()
    def option_add(self, *a): pass
    def columnconfigure(self, *a, **k): pass
    rowconfigure = columnconfigure
    def winfo_screenwidth(self): return 1920
    def winfo_screenheight(self): return 1080
    def iconbitmap(self, *a, **k): pass
    def attributes(self, *a, **k): pass
class Tk(Misc): pass
class PhotoImage(Misc):
    def width(self): return 16
    def height(self): return 16
def __getattr__(name):
    # Widgets and constants this stand-in does not spell out: a plain widget.
    if name.startswith('__'): raise AttributeError(name)
    if name[:1].isupper() and not name.isupper(): return type(name, (Misc,), {})
    return name.lower()
Toplevel = Tk
class Frame(Misc): pass
LabelFrame = Frame
class Label(Misc):
    def __init__(self, master=None, **kw):
        super().__init__(master, **kw)
        if 'text' in kw: _texts.append(str(kw['text']))
class Button(Misc): pass
class Entry(Misc):
    def get(self): return ''
    def insert(self, *a): pass
    def delete(self, *a): pass
class Canvas(Misc):
    def __init__(self, master=None, **kw): super().__init__(master, **kw); self.items = {}; self.n = 0; _canvases.append(self)
    def _add(self, kind, c, kw):
        if len(c) == 1 and isinstance(c[0], (list, tuple)): c = c[0]
        self.n += 1; self.items[self.n] = [kind, [float(v) for v in c], dict(kw)]
        if kind == 'text': _texts.append(str(kw.get('text', '')))
        return self.n
    def create_rectangle(self, *c, **k): return self._add('rect', c, k)
    def create_oval(self, *c, **k): return self._add('oval', c, k)
    def create_line(self, *c, **k): return self._add('line', c, k)
    def create_polygon(self, *c, **k): return self._add('poly', c, k)
    def create_text(self, *c, **k): return self._add('text', c, k)
    def create_image(self, *c, **k): return self._add('image', c, k)
    def create_arc(self, *c, **k): return self._add('oval', c, k)
    def _ids(self, tag):
        if tag in ('all', ALL): return list(self.items)
        if isinstance(tag, int): return [tag] if tag in self.items else []
        out = []
        for i, it in self.items.items():
            t = it[2].get('tags')
            if t == tag or (isinstance(t, (list, tuple)) and tag in t): out.append(i)
        return out
    def delete(self, *tags):
        for t in tags:
            for i in self._ids(t): self.items.pop(i, None)
    def coords(self, tag, *c):
        ids = self._ids(tag)
        if not c: return self.items[ids[0]][1] if ids else []
        if len(c) == 1 and isinstance(c[0], (list, tuple)): c = c[0]
        for i in ids: self.items[i][1] = [float(v) for v in c]
    def move(self, tag, dx, dy):
        for i in self._ids(tag): self.items[i][1] = [v + (dx if k % 2 == 0 else dy) for k, v in enumerate(self.items[i][1])]
    def itemconfig(self, tag, **kw):
        for i in self._ids(tag): self.items[i][2].update(kw)
        if 'text' in kw: _texts.append(str(kw['text']))
    itemconfigure = itemconfig
    def find_all(self): return tuple(self.items)
    def tag_raise(self, *a): pass
    tag_lower = lift = lower = tag_raise
    def bbox(self, *a): return (0, 0, 10, 10)
def _fire(keysym):
    e = Event(); e.keysym = keysym; e.char = keysym if len(keysym) == 1 else (' ' if keysym == 'space' else ''); e.keycode = 0; e.keysym_num = 0; e.state = 0; e.x = e.y = 0; e.widget = None; e.type = '2'
    names = ['<%s>' % keysym, '<KeyPress-%s>' % keysym, '<Key-%s>' % keysym, '<Key>', '<KeyPress>'] + ([keysym] if len(keysym) == 1 else [])
    hit = False
    for n in names:
        for fn in list(_binds.get(n, [])):
            if fn: fn(e); hit = True
    return hit
def _shape():
    return tuple(sorted((k, tuple(round(v) for v in c), str(kw.get('fill'))) for cv in _canvases for k, c, kw in cv.items.values()))
OVER = re.compile(r'game\s*over|you (?:lose|lost|died)|final score', re.I)
def _over():
    return any(OVER.search(t) for t in _texts[-30:]) or any(OVER.search(str(kw.get('text', ''))) for cv in _canvases for k, c, kw in cv.items.values() if k == 'text')
def _step(until):
    global _now
    while _q and _q[0][0] <= until:
        t, i, fn, args = heapq.heappop(_q); _now = max(_now, t); fn(*args)
    _now = max(_now, until)
def _run():
    global _now, _texts
    plan = [(500, 'Left'), (700, 'Left'), (900, 'Up'), (1100, 'Right'), (1300, 'Down'), (1500, 'space')]
    for t, k in plan:
        _step(t)
        print('KEY %s %s' % (k, 'bound' if _fire(k) else 'unbound'), flush=True)
    # Played on, with nothing pressed, for up to five minutes of its own time.
    # Nothing on the canvas changing for thirty seconds, while not over, is
    # a game that froze: a Tetris whose second piece never came.
    t = 1500
    shape = _shape(); changed = t
    while t < 300000 and not _over():
        t += 250
        _step(t)
        if not _q and not _over():
            print('STOPPED %d' % _now, flush=True); print('END', flush=True); return
        now_shape = _shape()
        if now_shape != shape:
            shape = now_shape; changed = t
        elif t - changed >= 30000:
            print('STILL %d' % changed, flush=True); print('END', flush=True); return
    if not _over():
        print('NEVER OVER', flush=True); print('MOVING yes', flush=True); print('END', flush=True); return
    print('OVER %d' % _now, flush=True)
    for k in ('space', 'Return', 'r', 'R'):
        _texts = []
        before = _shape()
        _fire(k)
        _step(_now + 400)
        if not _over() and _shape() != before:
            print('RESTARTED %s' % k, flush=True)
            a = _shape(); _step(_now + 5000); b = _shape()
            print('MOVING %s' % ('yes' if (a != b and _q) else 'no'), flush=True)
            print('END', flush=True); return
    print('RESTARTED none', flush=True); print('END', flush=True)
`

export const FAKE_TK_MESSAGEBOX = String.raw`
import tkinter as _tk
def showinfo(*a, **k):
    _tk._texts.append(' '.join(str(x) for x in a) + ' ' + str(k.get('message', '')))
    return 'ok'
showwarning = showerror = showinfo
def askyesno(*a, **k):
    _tk._texts.append(' '.join(str(x) for x in a) + ' ' + str(k.get('message', '')))
    return True
askokcancel = askretrycancel = askyesno
def askquestion(*a, **k): return 'yes'
`

export const FAKE_TK_FONT = String.raw`
class Font:
    def __init__(self, *a, **k): pass
    def measure(self, t): return 8 * len(str(t))
    def metrics(self, *a): return 14
    def configure(self, **k): pass
def families(*a): return ()
`

/** What the stand-in saw, said as a player would. Null: nothing wrong. */
export function tkVerdict(out: string): { ok: boolean; line: string } {
  const lines = out.split(/\r?\n/)
  const unbound = lines.filter((l) => /^KEY \S+ unbound$/.test(l)).map((l) => l.split(' ')[1])
  const keys = unbound.length === 6 ? ' None of the keys pressed - the arrows, Space - did anything: is anything bound?' : ''
  if (lines.some((l) => l.startsWith('STOPPED'))) {
    return { ok: false, line: `Played on its own clock: its game loop stopped by itself before the game was over - nothing was left scheduled with after().${keys}` }
  }
  const still = lines.find((l) => l.startsWith('STILL '))
  if (still) {
    const at = Math.round(Number(still.split(' ')[1]) / 1000)
    return {
      ok: false,
      line: `Played on its own clock: ${at} seconds in, everything on its canvas stopped changing, and stayed so for thirty seconds without the game being over - it froze (a piece that never comes, a loop doing nothing).${keys}`
    }
  }
  if (lines.includes('NEVER OVER')) return { ok: !keys, line: `Played five minutes of its own time with no keys pressed: it kept running and never ended.${keys}` }
  const raw = lines.find((l) => l.startsWith('RESTARTED'))?.split(' ')[1]
  const how = raw === 'space' ? 'Space' : raw === 'Return' ? 'Enter' : raw === 'r' || raw === 'R' ? 'R' : raw
  if (how === 'none') return { ok: false, line: `Played until it said the game was over; then Space, Enter and R were each pressed, and none started a new game.${keys}` }
  if (lines.includes('MOVING no')) {
    return {
      ok: false,
      line: `Played until it said the game was over; ${how} started a new game, but it then stood still for five seconds - nothing scheduled with after(). Its loop stopped at game over and was not started again.${keys}`
    }
  }
  return { ok: !keys, line: `Played until it was over, and ${how} started a new game that runs.${keys}` }
}
