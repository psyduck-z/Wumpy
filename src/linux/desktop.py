#!/usr/bin/env python3
"""
Wumpy's desktop helper for Linux (Hyprland): the same line protocol as
src/hook (WumpyHook.exe) on Windows, so src/main/input.ts drives both alike.

One command in on stdin, one reply out on stdout, always beginning with the
verb it was given, because the Electron side matches replies by that word.

    MOVE x y                 CLICK x y [left|right] [times]
    SCROLL x y notches       TYPE <base64>          KEY <chord> [times]
    GUARD                    FOCUSED                ELEMENTS [limit] [filter]
    PRESS <b64>  FOCUS <b64>  VALUE <b64>  REVEAL <b64>

Coordinates are Hyprland layout coordinates, which are what Electron's
screen module reports, so src/shared/steps.ts toScreen needs no change.

Hands: `hyprctl dispatch hl.dsp.cursor.move` puts the pointer; wumpy-pointer (C,
wlr-virtual-pointer) presses and scrolls; wtype types. None needs root.
Eyes: AT-SPI, the Linux accessibility tree, for names. An app shows its tree
only while accessibility is on, so this turns it on (org.a11y.Status) at
start; an app started before that may need restarting to show one.

Run by src/main/linuxdesktop.ts:  desktop.py --owner=<wumpy pid>
"""
import base64
import json
import os
import subprocess
import sys
import time
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
POINTER = os.path.join(HERE, 'wumpy-pointer')
OWNER = 0
for a in sys.argv[1:]:
    if a.startswith('--owner='):
        try:
            OWNER = int(a.split('=', 1)[1])
        except ValueError:
            pass

try:
    import gi

    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:  # no AT-SPI: the hands still work, the names do not
    Atspi = None


def out(line):
    sys.stdout.write(line.replace('\n', ' ') + '\n')
    sys.stdout.flush()


def b64(s):
    return base64.b64encode((s or '').encode('utf-8')).decode('ascii')


def unb64(s):
    return base64.b64decode(s.encode('ascii'), validate=True).decode('utf-8')


def run(args, data=None, timeout=5):
    try:
        p = subprocess.run(args, input=data, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except Exception as e:  # missing tool, timeout
        return 127, '', str(e)


def hypr(*args):
    code, text, _ = run(['hyprctl', '-j', *args])
    if code != 0:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def cursor():
    c = hypr('cursorpos')
    return (int(c['x']), int(c['y'])) if c else None


# Where the pointer was left by the helper itself, and where the user had it
# before that. Focus follows the mouse here (input:follow_mouse = 1), so
# putting the pointer back after a click hands the keyboard to whatever is
# under it - often Wumpy's own panel; and focusing a window warps the pointer
# to it (cursor:no_warps = false). So the pointer stays where Wumpy put it,
# and GUARD reports the user's position for as long as it is still there: a
# hand on the mouse moves it off that spot, and that is still noticed.
PLACED = {'at': None, 'user': None}


def placed(before):
    """Wumpy moved the pointer from `before`: remember both ends."""
    now = cursor()
    if not now:
        return now
    prior = PLACED['at']
    if prior is None or not near(before, prior):
        PLACED['user'] = before  # the first of our moves since the user's own
    PLACED['at'] = now
    return now


def near(a, b, slack=3):
    return bool(a) and bool(b) and abs(a[0] - b[0]) <= slack and abs(a[1] - b[1]) <= slack


def put(x, y):
    dispatch(f'hl.dsp.cursor.move({{ x = {int(x)}, y = {int(y)} }})', ['movecursor', str(int(x)), str(int(y))])
    return cursor()


# ----------------------------------------------------------------- windows

def ours(w):
    return bool(w) and (w.get('pid') == OWNER or str(w.get('class', '')).lower() == 'wumpy')


def target_window():
    """The window being worked in: the one in front, or the one behind Wumpy."""
    active = hypr('activewindow')
    if active and not ours(active):
        return active
    clients = hypr('clients') or []
    # Only a window on a workspace that is showing: focusing one elsewhere
    # would switch their workspace out from under them.
    shown = {m.get('activeWorkspace', {}).get('id') for m in (hypr('monitors') or [])}
    shown |= {m.get('specialWorkspace', {}).get('id') for m in (hypr('monitors') or []) if m.get('specialWorkspace', {}).get('id')}
    behind = [
        c for c in clients
        if c.get('mapped', True) and not c.get('hidden') and not ours(c) and c.get('focusHistoryID', -1) >= 0
        and c.get('workspace', {}).get('id') in shown
    ]
    behind.sort(key=lambda c: c.get('focusHistoryID', 99))
    return behind[0] if behind else None


def guard():
    active = hypr('activewindow') or {}
    at = cursor() or (-1, -1)
    if PLACED['at'] and near(at, PLACED['at']) and PLACED['user']:
        at = PLACED['user']  # still where Wumpy left it: report where they had it
    elif PLACED['at'] and not near(at, PLACED['at']):
        PLACED['at'] = PLACED['user'] = None  # they have moved it since
    target = target_window() or {}
    try:
        hwnd = int(str(active.get('address', '0')), 16)
    except ValueError:
        hwnd = 0
    # keyms/clickms -1: Wayland tells no program about other programs' input,
    # so "you typed" cannot be seen here; the pointer and window still can.
    out(
        f"GUARD ok hwnd={hwnd} cursor={at[0]},{at[1]} keyms=-1 clickms=-1 click=none mousehook=off "
        f"own={'yes' if ours(active) else 'no'} target={b64(target.get('title', ''))} "
        f"title={b64(active.get('title', ''))}"
    )


# ------------------------------------------------------------------- hands

def move(x, y):
    before = cursor()
    at = put(x, y)
    placed(before)
    if not at:
        return out('MOVE FAILED hyprctl')
    out(f"MOVE {'ok' if at == (x, y) else 'CLAMPED'} at={at[0]},{at[1]}")


def press_here(verb, args):
    if not os.access(POINTER, os.X_OK):
        return None, f'{verb} FAILED no-pointer-helper'
    code, text, err = run([POINTER, *args])
    if code != 0 or not text.startswith('ok'):
        return None, f"{verb} FAILED {text or err or 'pointer-helper'}"
    return text, None


def click(x, y, button, times):
    before = cursor()
    at = put(x, y)
    if not at:
        return out('CLICK FAILED hyprctl')
    if abs(at[0] - x) > 1 or abs(at[1] - y) > 1:
        if before:
            put(*before)
        return out(f'CLICK REFUSED off-screen asked={x},{y} landed={at[0]},{at[1]}')
    placed(before)
    time.sleep(0.03)  # let the app see the pointer arrive before the press
    _, fail = press_here('CLICK', ['click', button, str(times)])
    if fail:
        return out(fail)
    # Left where it clicked, not put back: see PLACED.
    out(f"CLICK ok at={x},{y} button={button} times={times} pointer=left-there")


def scroll(x, y, notches):
    if notches == 0:
        return out('SCROLL ok notches=0 nothing-to-do')
    before = cursor()
    at = put(x, y)
    if not at or abs(at[0] - x) > 1 or abs(at[1] - y) > 1:
        if before:
            put(*before)
        return out(f'SCROLL REFUSED off-screen asked={x},{y}')
    placed(before)
    _, fail = press_here('SCROLL', ['scroll', str(notches)])
    if fail:
        return out(fail)
    out(f"SCROLL ok at={x},{y} notches={notches} direction={'down' if notches > 0 else 'up'} pointer=left-there")


def keyboard_is_ours(verb):
    """
    Keystrokes go to whatever window has the keyboard, and on Wayland nothing
    aims them. A plan never means to type into Wumpy's own panel - it means the
    window behind it - so typing while the panel holds the keyboard is refused.
    Found the hard way: a test whose window failed to open typed its words
    into Wumpy, and its ctrl+a and backspaces then cleared the message box.
    """
    if ours(hypr('activewindow')):
        out(f'{verb} FAILED keyboard-is-in-wumpy: press, focus or fill the box first so its window has the keyboard')
        return True
    return False


def type_text(text):
    if not text:
        return out('TYPE ok chars=0')
    if keyboard_is_ours('TYPE'):
        return None
    code, _, err = run(['wtype', '-'], data=text, timeout=30)
    out(f'TYPE ok chars={len(text)}' if code == 0 else f'TYPE FAILED {err or "wtype"}')


MODS = {'ctrl': 'ctrl', 'control': 'ctrl', 'shift': 'shift', 'alt': 'alt', 'win': 'logo', 'super': 'logo', 'meta': 'logo', 'cmd': 'logo'}
KEYS = {
    'enter': 'Return', 'return': 'Return', 'esc': 'Escape', 'escape': 'Escape', 'tab': 'Tab',
    'backspace': 'BackSpace', 'back': 'BackSpace', 'delete': 'Delete', 'del': 'Delete', 'insert': 'Insert',
    'home': 'Home', 'end': 'End', 'pageup': 'Page_Up', 'pgup': 'Page_Up', 'pagedown': 'Page_Down',
    'pgdn': 'Page_Down', 'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right', 'space': 'space',
    'menu': 'Menu', 'apps': 'Menu', 'printscreen': 'Print', 'capslock': 'Caps_Lock',
}


def key(chord, times):
    parts = [p for p in chord.lower().split('+') if p]
    if not parts:
        return out('KEY FAILED empty')
    *mods, last = parts
    mod = [MODS.get(m) for m in mods]
    if None in mod:
        return out(f'KEY FAILED unknown-modifier chord={chord}')
    if last in MODS:  # a modifier alone, like "win"
        name = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L', 'logo': 'Super_L'}[MODS[last]]
    elif last in KEYS:
        name = KEYS[last]
    elif len(last) >= 2 and last[0] == 'f' and last[1:].isdigit():
        name = 'F' + last[1:]
    elif len(last) == 1:
        name = last
    else:
        return out(f'KEY FAILED unknown-key chord={chord}')
    if keyboard_is_ours('KEY'):
        return None
    if times < 1 or times > 400:
        return out(f'KEY FAILED repeat-out-of-range={times}')
    what = f'{chord} x{times}' if times > 1 else chord
    # wumpy-pointer's keyboard first: wtype's BackSpace, Delete and ctrl+
    # shortcuts vanish when fcitx5 is running (see wumpy-pointer.c). wtype
    # only where the compositor has no virtual keyboard for it.
    if os.access(POINTER, os.X_OK):
        code, text, err = run([POINTER, 'key', ','.join(mod) or '-', name, str(times)], timeout=20)
        if code == 0 and text.startswith('ok'):
            return out(f'KEY ok chord={what}')
        if 'no-virtual-keyboard' not in text:
            return out(f"KEY FAILED chord={what} {text or err or 'keyboard-helper'}")
    args = ['wtype']
    for m in mod:
        args += ['-M', m]
    for _ in range(times):
        args += ['-k', name]
    for m in reversed(mod):
        args += ['-m', m]
    code, _, err = run(args, timeout=20)
    out(f'KEY ok chord={what}' if code == 0 else f'KEY FAILED chord={what} {err or "wtype"}')


# -------------------------------------------------------------------- eyes

if Atspi is not None:
    R = Atspi.Role
    ROLES = {
        R.PUSH_BUTTON: 'Button', R.TOGGLE_BUTTON: 'Button', R.ENTRY: 'Edit', R.PASSWORD_TEXT: 'Edit',
        R.SPIN_BUTTON: 'Edit', R.LINK: 'Hyperlink', R.MENU_ITEM: 'MenuItem', R.CHECK_MENU_ITEM: 'MenuItem',
        R.RADIO_MENU_ITEM: 'MenuItem', R.PAGE_TAB: 'TabItem', R.PAGE_TAB_LIST: 'Tab', R.CHECK_BOX: 'CheckBox',
        R.RADIO_BUTTON: 'RadioButton', R.COMBO_BOX: 'ComboBox', R.LIST_ITEM: 'ListItem',
        R.DOCUMENT_WEB: 'Document', R.DOCUMENT_FRAME: 'Document', R.DOCUMENT_TEXT: 'Document',
        R.LABEL: 'Text', R.STATIC: 'Text', R.HEADING: 'Text', R.PARAGRAPH: 'Text',
    }
    S = Atspi.StateType
    try:
        Atspi.set_timeout(1500, 5000)
    except Exception:
        pass
else:
    ROLES = {}


def enable_accessibility():
    run(['busctl', '--user', 'set-property', 'org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Status', 'IsEnabled', 'b', 'true'])


def states(acc):
    try:
        return acc.get_state_set()
    except Exception:
        return None


def has(st, state):
    return st is not None and st.contains(state)


def role_of(acc, st):
    try:
        r = acc.get_role()
    except Exception:
        return None
    name = ROLES.get(r)
    editable = has(st, S.EDITABLE)
    if name == 'Document':
        return 'Document'
    if editable and has(st, S.FOCUSABLE):
        return 'Edit'
    if r == R.TEXT:
        return 'Edit' if editable else 'Text'
    return name


def app_for(window):
    if Atspi is None or not window:
        return None
    pid = window.get('pid')
    desk = Atspi.get_desktop(0)
    for i in range(desk.get_child_count()):
        try:
            a = desk.get_child_at_index(i)
            if a is not None and a.get_process_id() == pid:
                return a
        except Exception:
            continue
    return None


def frame_for(app, window):
    """The app's top-level that is this window: by title, else the active one."""
    best = None
    title = (window or {}).get('title', '')
    for i in range(app.get_child_count()):
        try:
            f = app.get_child_at_index(i)
            if f is None:
                continue
            if title and f.get_name() == title:
                return f
            if best is None or has(states(f), S.ACTIVE):
                best = f
        except Exception:
            continue
    return best


def extents(acc, window):
    """Screen rectangle: window-relative from AT-SPI, plus where Hyprland put the window."""
    try:
        e = acc.get_extents(Atspi.CoordType.WINDOW)
    except Exception:
        return None
    if e.width < 2 or e.height < 2:
        return None
    wx, wy = (window or {}).get('at', [0, 0])
    return (wx + e.x, wy + e.y, e.width, e.height)


def walk(window, limit=4000, budget=3.0, offscreen=False):
    """Every named, enabled, useful control in the window, as (acc, name, role, x, y, w, h)."""
    app = app_for(window)
    if app is None:
        return None
    root = frame_for(app, window)
    if root is None:
        return None
    found, stack, seen, start = [], [root], 0, time.monotonic()
    while stack and len(found) < limit and seen < 20000 and time.monotonic() - start < budget:
        acc = stack.pop()
        seen += 1
        st = states(acc)
        if st is not None and not offscreen and not has(st, S.SHOWING) and acc is not root:
            continue
        role = role_of(acc, st)
        if role:
            try:
                name = (acc.get_name() or '').strip()
            except Exception:
                name = ''
            if name and (has(st, S.ENABLED) or has(st, S.SENSITIVE)):
                box = extents(acc, window)
                if box:
                    found.append((acc, name[:80], role, *box))
        try:
            n = acc.get_child_count()
        except Exception:
            n = 0
        for i in range(min(n, 400) - 1, -1, -1):
            try:
                c = acc.get_child_at_index(i)
                if c is not None:
                    stack.append(c)
            except Exception:
                continue
    return found


def score(name, want):
    n, w = name.lower(), want.lower()
    if n == w:
        return 100
    if n.startswith(w):
        return 80
    if w in n:
        return 60
    words = w.split()
    if len(words) > 1 and all(x in n for x in words):
        return 40
    return 0


def best(found, want, prefer_editable):
    ranked = []
    for f in found:
        s = score(f[1], want)
        if not s:
            continue
        if prefer_editable and f[2] in ('Edit', 'ComboBox', 'Document'):
            s += 15
        ranked.append((s, -f[4], -f[3], f))
    if not ranked:
        return None
    ranked.sort(key=lambda r: (r[0], r[1], r[2]), reverse=True)
    return ranked[0][3]


def describe(f):
    _, name, role, x, y, w, h = f
    return f'name={b64(name)} role={role} at={x + w // 2},{y + h // 2} matched=spot'


def no_tree(verb, window):
    if Atspi is None:
        return out(f'{verb} FAILED no-accessibility (python-gobject with AT-SPI is not installed)')
    if not window:
        return out(f'{verb} FAILED no-window-to-act-on')
    out(f"{verb} FAILED no-accessibility-tree {window.get('class', '?')} shows no names; restarting that app after Wumpy turned accessibility on usually fixes it")


def elements(limit, filt):
    window = target_window()
    found = walk(window)
    if found is None:
        return no_tree('ELEMENTS', window)
    if filt:
        f = filt.lower()
        found = [x for x in found if f in x[1].lower() or f in x[2].lower()]
    rank = {'Edit': 0, 'ComboBox': 0, 'Text': 2, 'Document': 2}
    uniq, keys = [], set()
    for x in sorted(found, key=lambda x: (rank.get(x[2], 1), x[4], x[3])):
        k = (x[2], x[1])
        if k in keys:
            continue
        keys.add(k)
        uniq.append(x)
    listed = [
        {'name': x[1], 'role': x[2], 'x': x[3] + x[5] // 2, 'y': x[4] + x[6] // 2, 'w': x[5], 'h': x[6]}
        for x in uniq[:limit]
    ]
    out(f"ELEMENTS ok count={len(listed)} total={len(found)} window={b64(window.get('title', ''))} {json.dumps(listed)}")


def dispatch(lua, old):
    """Hyprland 0.56 dispatches in Lua and calls the old form an error; older ones only know the old form."""
    code, text, _ = run(['hyprctl', 'dispatch', lua])
    if code == 0 and not text.startswith('error'):
        return True
    code, text, _ = run(['hyprctl', 'dispatch', *old])
    return code == 0 and not text.startswith('error')


def focus_window(window):
    if not window or not window.get('address'):
        return False
    before = cursor()
    addr = window['address']
    ok = dispatch(f'hl.dsp.focus({{ window = "address:{addr}" }})', ['focuswindow', f'address:{addr}'])
    if before and not near(cursor(), before):
        placed(before)  # Hyprland warped the pointer to it: ours, not theirs
    return ok


def take_focus(acc):
    try:
        acc.grab_focus()
    except Exception:
        pass
    time.sleep(0.12)
    return has(states(acc), S.FOCUSED)


def press(want, focus_only, verb):
    window = target_window()
    found = walk(window)
    if found is None:
        return no_tree(verb, window)
    chosen = best(found, want, focus_only)
    if chosen is None:
        return out(f'{verb} FAILED nothing-named {b64(want)}')
    acc, what = chosen[0], describe(chosen)
    if focus_only or chosen[2] in ('Edit', 'ComboBox', 'Document'):
        # Keystrokes follow the compositor's focus, not the tree's: the window first.
        focus_window(window)
        took = take_focus(acc)
        return out(f'{verb} ok via=focus {what} focused=yes' if took else f'{verb} FAILED did-not-take-keyboard {what} via=focus focused=no')
    # The window forward first, as a click on it would: whatever is typed
    # next follows the compositor's focus, which is still on Wumpy's panel.
    focus_window(window)
    try:
        n = acc.get_n_actions()
        names = [(acc.get_action_name(i) or '').lower() for i in range(n)]
    except Exception:
        n, names = 0, []
    for wanted in ('click', 'press', 'activate', 'jump', 'toggle', 'select', 'open'):
        if wanted in names:
            try:
                if acc.do_action(names.index(wanted)):
                    return out(f'{verb} ok via={wanted} {what}')
            except Exception:
                pass
    if n:
        try:
            if acc.do_action(0):
                return out(f'{verb} ok via=action {what}')
        except Exception:
            pass
    out(f'{verb} FAILED no-action {what}')


def text_of(acc):
    try:
        count = Atspi.Text.get_character_count(acc)
        if count > 0:
            return Atspi.Text.get_text(acc, 0, count), 'text'
    except Exception:
        pass
    try:
        v = acc.get_current_value()
        return str(v), 'value'
    except Exception:
        pass
    return '', 'none'


def value(want):
    window = target_window()
    found = walk(window, offscreen=True)
    if found is None:
        return no_tree('VALUE', window)
    chosen = best(found, want, True)
    if chosen is None:
        return out(f'VALUE FAILED nothing-named {b64(want)}')
    text, via = text_of(chosen[0])
    text = text.replace('￼', '')[:600]
    out(f'VALUE ok via={via} name={b64(chosen[1])} role={chosen[2]} matched=spot len={len(text)} text={b64(text)}')


def reveal(want):
    window = target_window()
    found = walk(window, offscreen=True)
    if found is None:
        return no_tree('REVEAL', window)
    chosen = best(found, want, False)
    if chosen is None:
        return out(f'REVEAL FAILED nothing-named {b64(want)}')
    try:
        ok = chosen[0].scroll_to(Atspi.ScrollType.ANYWHERE)
    except Exception:
        ok = False
    out(f"REVEAL {'ok' if ok else 'FAILED could-not-scroll'} via=scroll {describe(chosen)}")


def focused():
    window = hypr('activewindow')
    if Atspi is None or not window:
        return no_tree('FOCUSED', window)
    app = app_for(window)
    root = frame_for(app, window) if app else None
    if root is None:
        return no_tree('FOCUSED', window)
    stack, start, el = [root], time.monotonic(), None
    while stack and time.monotonic() - start < 3.0:
        acc = stack.pop()
        st = states(acc)
        if has(st, S.FOCUSED):
            el = acc
            break
        if st is not None and acc is not root and not has(st, S.SHOWING):
            continue
        try:
            n = acc.get_child_count()
        except Exception:
            n = 0
        for i in range(min(n, 400) - 1, -1, -1):
            try:
                c = acc.get_child_at_index(i)
                if c is not None:
                    stack.append(c)
            except Exception:
                continue
    if el is None:
        return out('FOCUSED FAILED nothing-has-the-keyboard')
    st = states(el)
    role = role_of(el, st) or 'Pane'
    takes = 'yes' if has(st, S.EDITABLE) else ('readonly' if has(st, S.READ_ONLY) else 'no')
    selected = ''
    try:
        if el.get_n_selections() > 0:
            r = el.get_selection(0)
            selected = Atspi.Text.get_text(el, r.start_offset, r.end_offset)[:200]
    except Exception:
        pass
    try:
        name = el.get_name() or ''
    except Exception:
        name = ''
    out(f"FOCUSED ok role={role} ours={'yes' if ours(window) else 'no'} takes={takes} name={b64(name)} selected={b64(selected)}")


# -------------------------------------------------------------------- loop

def ints(bits, n):
    return [int(b) for b in bits[:n]]


def command(line):
    verb, _, rest = line.partition(' ')
    verb, rest = verb.upper(), rest.strip()
    bits = rest.split()
    try:
        if verb in ('MOVE', 'CLICK'):
            try:
                x, y = ints(bits, 2)
            except ValueError:
                return out(f'{verb} FAILED bad-coordinates')
            if verb == 'MOVE':
                return move(x, y)
            button = bits[2].lower() if len(bits) > 2 and bits[2].lower() in ('left', 'right', 'middle') else 'left'
            times = max(1, min(3, int(bits[3]))) if len(bits) > 3 and bits[3].isdigit() else 1
            return click(x, y, button, times)
        if verb == 'SCROLL':
            try:
                x, y, n = ints(bits, 3)
            except ValueError:
                return out('SCROLL FAILED bad-arguments')
            return scroll(x, y, n)
        if verb == 'TYPE':
            try:
                return type_text(unb64(rest))
            except Exception:
                return out('TYPE FAILED not-base64')
        if verb == 'KEY':
            times = int(bits[1]) if len(bits) > 1 and bits[1].isdigit() else 1
            return key(bits[0] if bits else '', times)
        if verb == 'GUARD':
            return guard()
        if verb == 'FOCUSED':
            return focused()
        if verb == 'ELEMENTS':
            limit = max(1, min(200, int(bits[0]))) if bits and bits[0].isdigit() else 60
            return elements(limit, ' '.join(bits[1:]).strip())
        if verb in ('PRESS', 'FOCUS', 'VALUE', 'REVEAL'):
            try:
                name = unb64(rest)
            except Exception:
                return out(f'{verb} FAILED not-base64')
            if verb == 'VALUE':
                return value(name)
            if verb == 'REVEAL':
                return reveal(name)
            return press(name, verb == 'FOCUS', verb)
        if verb == '':
            return None
        out(f'{verb} FAILED unknown-command')
    except Exception as e:  # one reply, always, or the caller waits forever
        out(f'{verb} FAILED {type(e).__name__}')


def main():
    if '--no-a11y' not in sys.argv:
        enable_accessibility()
    hands = 'pointer' if os.access(POINTER, os.X_OK) else 'no-pointer'
    eyes = 'atspi' if Atspi is not None else 'no-atspi'
    out(f'READY linux {hands} {eyes}')
    for line in sys.stdin:  # EOF: Wumpy has gone, and so does this
        command(line.strip())


if __name__ == '__main__':
    main()
