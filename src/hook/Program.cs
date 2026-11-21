// Wumpy's hotkey helper.
//
// Why this exists: Windows reserves Win+C for the shell (Copilot). RegisterHotKey
// — which is all Electron's globalShortcut can do — is refused for it outright,
// and the policy key that would free it lives under HKCU\Software\Policies,
// which is admin-only.
//
// A WH_KEYBOARD_LL hook sits ahead of the shell in the input chain, so it can see
// the keystroke *and swallow it*. That is the only way to genuinely take Win+C
// without elevation. PowerToys does the same thing for the same reason.
//
// This runs as a child process of the Electron app. It writes one line to stdout
// per trigger and exits when its stdin closes, so it can never outlive its parent.

using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

internal static class Program
{
    private const int WH_KEYBOARD_LL = 13;

    /// <summary>
    /// The mouse's own low-level hook.
    ///
    /// Added because the guard was half blind. It could see the user's
    /// keystrokes and the pointer's position, so it caught someone typing
    /// and someone shoving the mouse - and missed the most common
    /// interruption of all, which is a person clicking something while a
    /// plan is running. A click changes the focus, the selection and often
    /// the page, and the next synthesised keystroke then lands somewhere
    /// nobody chose.
    /// </summary>
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MOUSEWHEEL = 0x020A;

    /// <summary>Set on a mouse event we synthesised ourselves.</summary>
    private const uint LLMHF_INJECTED = 0x0001;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYUP = 0x0105;
    private const int HC_ACTION = 0;

    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;
    private const int VK_CONTROL = 0x11;
    private const int VK_F23 = 0x86;
    private const int VK_SHIFT = 0x10;

    private const uint LLKHF_INJECTED = 0x10;
    private const uint INPUT_KEYBOARD = 1;
    private const uint INPUT_MOUSE = 0;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    /// <summary>Types a character by its code point, whatever the keyboard layout is.</summary>
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;

    /// <summary>One notch of a wheel, as Windows counts it.</summary>
    private const int WHEEL_DELTA = 120;

    /// <summary>Marks input we synthesised, so the hook ignores its own events.</summary>
    private static readonly IntPtr WumpySignature = new(0x57554D50); // 'WUMP'

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT
    {
        [FieldOffset(0)] public uint type;
        // The union starts at 8 on x64 (4 bytes of type + 4 of alignment padding).
        [FieldOffset(8)] public KEYBDINPUT ki;
        // MOUSEINPUT is the union's largest member. It is never written, but
        // declaring it makes sizeof(INPUT) come out at the 40 bytes the OS
        // expects; without it the struct measures 32 and SendInput rejects
        // every call with ERROR_INVALID_PARAMETER.
        [FieldOffset(8)] public MOUSEINPUT mi;
    }

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint cInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern int GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int nExitCode);

    /// <summary>
    /// Lets another process take the foreground.
    ///
    /// Windows refuses SetForegroundWindow from a process that did not
    /// receive the last input, which Wumpy never has: the keystroke arrives
    /// here, in the hook, and Wumpy only hears about it afterwards. So the
    /// panel came up without the keyboard, and the fallback for that was to
    /// minimise and restore the window - the only route Windows does grant -
    /// which flickers and, measured over real hotkey presses, worked about
    /// two times in three.
    ///
    /// This process DID receive the input, so it is allowed to hand the
    /// right on. One call before the toggle is sent and Wumpy can simply
    /// focus itself: no flicker, nothing to retry.
    /// </summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint dwProcessId);

    /// <summary>
    /// Everything needed to take the foreground here rather than delegate it.
    ///
    /// AllowSetForegroundWindow hands Wumpy a one-shot token and hopes it is
    /// spent in time. That hope is the whole bug: the token is issued here,
    /// then TOGGLE goes down a pipe, Node wakes up, Electron shows a window
    /// and only then calls focus. Anything in that gap - including the Ctrl
    /// tap this process injects to stop the Start menu - and the panel comes
    /// up deaf.
    ///
    /// So the activation happens here instead, in the process that actually
    /// received the keystroke, on the window Wumpy names. Nothing has to
    /// survive a round trip.
    /// </summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    /// <summary>
    /// Join another thread's input queue, inheriting its right to grant the
    /// foreground. The documented way past the foreground rules when no
    /// grant is available, and the reason this no longer depends on one.
    /// </summary>
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    /// <summary>
    /// What Alt+Tab uses, and the lever that answers to nobody.
    ///
    /// Documented as not intended for general use and present since XP.
    /// Unlike SetForegroundWindow it is not subject to the foreground rules,
    /// which is exactly why it is here: measured, the attach-and-set route
    /// returned false on the first attempt even with the input queues joined.
    /// </summary>
    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetModuleHandleW(string? lpModuleName);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessageW(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    /*
     * The pointer, in real screen pixels.
     *
     * SetCursorPos rather than a MOUSEEVENTF_ABSOLUTE move: absolute mouse
     * input is 0..65535 normalised across the whole virtual desktop, which
     * has to be derived from four GetSystemMetrics calls and comes out wrong
     * by a rounding error on a multi-monitor desk, and by more than that when
     * the monitors have different scaling. This takes the pixels it is given.
     */
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out POINT lpPoint);

    // Held in a static field so the GC cannot collect the delegate the OS holds.
    private static readonly HookProc Callback = OnKey;
    private static readonly HookProc MouseCallback = OnMouse;
    private static IntPtr _hook = IntPtr.Zero;
    private static IntPtr _mouseHook = IntPtr.Zero;
    private static uint _mainThreadId;

    /// <summary>Process allowed to take the foreground, or 0 for none.</summary>
    private static uint _grantPid;

    /// <summary>TickCount of the last keystroke the user made themselves.</summary>
    private static long _lastRealKey;

    /// <summary>TickCount of the last click or wheel turn the user made.</summary>
    private static long _lastRealClick;

    /// <summary>What they did, for a line a person can read.</summary>
    private static string _lastClickWhat = string.Empty;

    /// <summary>Virtual-key code to intercept while a Windows key is held.</summary>
    private static uint _targetVk = 'C';

    /// <summary>
    /// Whether Shift must be held too (`--shift`). Wumpy asks for Win+Shift+Z,
    /// the same combination it uses on Linux, so the shortcut is one thing to
    /// remember across machines; Win+C stays the default for the selftest.
    /// </summary>
    private static bool _requireShift;

    /// <summary>
    /// The key whose current press has already been reported, or 0 for none.
    ///
    /// Auto-repeat is generated below this hook, so holding the combination
    /// delivers a fresh WM_KEYDOWN around thirty times a second. Reporting each
    /// one toggled the panel at that rate, which looks like flashing rather than
    /// like a hotkey. One press is one TOGGLE: the repeats and the release are
    /// swallowed and nothing more is sent until the key comes back up.
    /// </summary>
    private static uint _firedVk;

    /// <summary>When the last event for _firedVk arrived, for the stale check.</summary>
    private static long _firedAt;

    /// <summary>
    /// How long a held key may go quiet before the press is assumed abandoned.
    ///
    /// Without this, a release the hook never sees - a secure desktop, a hook
    /// dropped for being slow - would leave the key swallowed for good, and the
    /// letter C would stop working everywhere. Repeats refresh it, so a genuine
    /// hold never expires however long it lasts; the slowest repeat delay
    /// Windows offers is one second, so two is clear of a real one.
    /// </summary>
    private const long HeldTimeoutMs = 2000;

    private static int Main(string[] args)
    {
        // Accept a single letter or a raw 0x.. virtual-key code.
        //
        // Flags are skipped rather than read as the key: taking args[0] blindly
        // meant `--selftest` set the target to '-', so the self-test watched a
        // key nobody presses and every scenario in it was vacuous.
        // --grant-foreground=<pid>: who may take the foreground when the
        // hotkey fires. Optional, so the helper still runs standalone and
        // the self-test needs no process to point at.
        var grant = Array.Find(args, a => a.StartsWith("--grant-foreground=", StringComparison.OrdinalIgnoreCase));
        if (grant is not null && uint.TryParse(grant["--grant-foreground=".Length..], out var grantPid))
        {
            _grantPid = grantPid;
            /*
             * The same pid, used for the opposite question.
             *
             * It says who may take the foreground; it also says which windows
             * belong to Wumpy - and a plan must never act on one of those.
             * Without this, a lookup by name searched whatever had the
             * foreground, which at the moment a plan starts is the panel the
             * user just typed into: one attempt pressed a control named
             * `Press "Inbox - zechariah"`, which is the text of Wumpy's own
             * step card. See UiTree.Target.
             */
            UiTree.Owner = grantPid;
        }

        _requireShift = Array.Exists(args, a => a == "--shift");
        var key = Array.Find(args, a => a.Length > 0 && !a.StartsWith('-'));
        if (key is not null)
        {
            _targetVk = key.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToUInt32(key[2..], 16)
                : char.ToUpperInvariant(key[0]);
        }

        // `--selftest` validates the P/Invoke signatures and the INPUT union
        // layout without needing a human to press anything.
        if (args.Contains("--selftest"))
        {
            var probe = SetWindowsHookExW(WH_KEYBOARD_LL, Callback, GetModuleHandleW(null), 0);
            var hookOk = probe != IntPtr.Zero;
            if (hookOk) UnhookWindowsHookEx(probe);

            var sent = SendInputSelfTest();
            var err = sent == 2 ? 0 : Marshal.GetLastWin32Error();
            var keysOk = KeySelfTest();
            /*
             * The pointer BEFORE the foreground probe, not after.
             *
             * ForegroundSelfTest exists only to prove its P/Invokes resolve,
             * and it does that by calling SetForegroundWindow(NULL) and
             * SwitchToThisWindow(NULL) - deliberately poking the input and
             * foreground state with null handles. Run after it, SetCursorPos
             * came back false with no error code, three times in a row,
             * while the same binary moved the pointer perfectly through its
             * normal command path seconds later.
             *
             * So the self-test was failing the self-test. Ordering is the
             * whole fix: measure the pointer while the process has not yet
             * disturbed anything.
             */
            var pointer = PointerSelfTest();
            var fgOk = ForegroundSelfTest();
            Console.WriteLine(
                $"hook={(hookOk ? "ok" : "FAIL")} " +
                $"sizeof(INPUT)={Marshal.SizeOf<INPUT>()} " +
                $"sendinput={(sent == 2 ? "ok" : $"FAIL(sent={sent}, err={err})")} " +
                $"keys={(keysOk ? "ok" : "FAIL")} " +
                $"foreground={(fgOk ? "ok" : "FAIL")} " +
                $"pointer={pointer}");
            /* pointer is excluded: "blocked" is Windows declining, not a defect. */
            return hookOk && sent == 2 && keysOk && fgOk && pointer != "FAIL" ? 0 : 1;
        }

        _mainThreadId = GetCurrentThreadId();

        _hook = SetWindowsHookExW(WH_KEYBOARD_LL, Callback, GetModuleHandleW(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Console.Error.WriteLine($"FATAL SetWindowsHookEx failed: {Marshal.GetLastWin32Error()}");
            return 1;
        }

        /*
         * The mouse hook is wanted, not needed.
         *
         * Without it the guard cannot see a click, which is the commonest
         * way a person interrupts a plan. With it failing, everything else
         * still works - the hotkey, the typing, the keystroke half of the
         * guard - so a failure here is reported and carried past rather
         * than fatal. It observes only: every event is passed straight on.
         */
        _mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseCallback, GetModuleHandleW(null), 0);
        if (_mouseHook == IntPtr.Zero)
        {
            Console.Error.WriteLine(
                $"WARN mouse hook failed: {Marshal.GetLastWin32Error()} - " +
                "the guard will not see clicks");
        }

        Console.WriteLine($"READY vk=0x{_targetVk:X2}");
        Console.Out.Flush();

        /*
         * Two jobs on one thread.
         *
         * Die with the parent: when Electron closes the pipe, stdin hits EOF.
         * That has always been here and is what guarantees this process cannot
         * outlive Wumpy even if Wumpy is killed outright.
         *
         * And take orders: `ACTIVATE <hwnd>` asks for the foreground to be
         * given to that window, from here, because this is the process that
         * received the keystroke. Reading lines rather than draining bytes is
         * the only change to the lifetime guarantee - EOF still ends the loop.
         */
        var watchdog = new Thread(() =>
        {
            try
            {
                using var reader = new StreamReader(Console.OpenStandardInput());
                string? line;
                while ((line = reader.ReadLine()) is not null)
                {
                    var text = line.Trim();
                    if (text.StartsWith("ACTIVATE ", StringComparison.OrdinalIgnoreCase)
                        && long.TryParse(text.AsSpan(9), out var raw))
                    {
                        Activate(new IntPtr(raw));
                    }
                    else
                    {
                        Command(text);
                    }
                }
            }
            catch { /* pipe torn down */ }
            PostThreadMessageW(_mainThreadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        })
        { IsBackground = true };
        watchdog.Start();

        // A low-level hook only receives callbacks on a thread with a message loop.
        while (GetMessageW(out _, IntPtr.Zero, 0, 0) > 0) { }

        UnhookWindowsHookEx(_hook);
        return 0;
    }

    /// <summary>What to do with one keyboard event.</summary>
    private enum Act
    {
        /// <summary>Not ours: hand it on to the shell and the focused app.</summary>
        Pass,
        /// <summary>Ours, but already acted on: eat it and say nothing.</summary>
        Swallow,
        /// <summary>A fresh press of the combination: eat it and report it.</summary>
        Toggle
    }

    /// <summary>
    /// The whole hotkey decision, with nothing in it that needs a keyboard.
    ///
    /// It is separate from OnKey so that --selftest can drive real sequences
    /// through the code that ships - press and hold, Win let go first, a release
    /// the hook never saw - rather than through a second copy of the rules
    /// written to agree with them. The repeat bug this exists to catch is
    /// invisible to any test that only presses the key once.
    /// </summary>
    private static Act Decide(bool isDown, bool isUp, uint vkCode, bool winHeld, bool shiftHeld, bool injected, long now)
    {
        if (!isDown && !isUp) return Act.Pass;

        // Never react to input we injected ourselves.
        if (injected) return Act.Pass;

        if (_firedVk != 0 && now - _firedAt > HeldTimeoutMs) _firedVk = 0;

        // Everything else about a press we have already reported belongs to us:
        // its repeats, and its release. Deliberately without re-checking Win,
        // because releasing Win first leaves C repeating on its own - and those
        // repeats are the swallowed keystroke, not typing.
        if (_firedVk != 0 && vkCode == _firedVk)
        {
            _firedAt = now;
            if (isUp) _firedVk = 0;
            return Act.Swallow;
        }

        if (!isDown) return Act.Pass;

        // The dedicated Copilot key reports as Shift+Win+F23 rather than its own code.
        var isCopilotKey = vkCode == VK_F23 && winHeld;
        var isTarget = winHeld && vkCode == _targetVk && (!_requireShift || shiftHeld);
        if (!(isTarget || isCopilotKey)) return Act.Pass;

        _firedVk = vkCode;
        _firedAt = now;
        return Act.Toggle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    /// <summary>
    /// Watches the mouse without touching it.
    ///
    /// A click is the commonest way a person takes the machine back, and
    /// until now it was the one interruption the guard could not see: it
    /// knew about keystrokes, because the keyboard hook was already there,
    /// and about the pointer moving, by comparing positions. Someone
    /// clicking a different field moved nothing and typed nothing, and the
    /// plan carried on into whatever that click had just selected.
    ///
    /// Two ways to tell our own events from theirs, the same two the
    /// keyboard uses: our signature in dwExtraInfo, and LLMHF_INJECTED for
    /// anything else synthesised. Everything is passed on unchanged - this
    /// hook never swallows an event, so the worst it can cost is the
    /// microseconds of being in the chain.
    /// </summary>
    private static IntPtr OnMouse(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode != HC_ACTION) return CallNextHookEx(_mouseHook, nCode, wParam, lParam);

        var message = (int)wParam;
        if (message is WM_LBUTTONDOWN or WM_RBUTTONDOWN or WM_MBUTTONDOWN or WM_MOUSEWHEEL)
        {
            var data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            var ours = data.dwExtraInfo == WumpySignature;
            var injected = (data.flags & LLMHF_INJECTED) != 0;
            if (!ours && !injected)
            {
                _lastRealClick = Environment.TickCount64;
                _lastClickWhat = message switch
                {
                    WM_LBUTTONDOWN => "left-click",
                    WM_RBUTTONDOWN => "right-click",
                    WM_MBUTTONDOWN => "middle-click",
                    _ => "wheel"
                };
            }
        }

        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode != HC_ACTION) return CallNextHookEx(_hook, nCode, wParam, lParam);

        var msg = (int)wParam;
        var isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        var isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        if (!isDown && !isUp)
            return CallNextHookEx(_hook, nCode, wParam, lParam);

        var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
        var injected = data.dwExtraInfo == WumpySignature || (data.flags & LLKHF_INJECTED) != 0;

        /*
         * When the person last touched the keyboard themselves.
         *
         * This hook is already the only place in Wumpy that can tell a real
         * keystroke from one we synthesised - the signature on our own
         * events, and LLKHF_INJECTED for anyone else's - so it is the only
         * place that can answer "is the user doing something right now".
         *
         * Which is the question a plan has to ask between steps: "if it
         * detects that it's on the wrong page or like you're interfering
         * make it stop... Otherwise, I might like mess up some stuff." A
         * plan carrying on while someone types into the same box is how two
         * sets of keystrokes get interleaved into one field.
         */
        if (!injected && isDown) _lastRealKey = Environment.TickCount64;

        var winHeld = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0
                      || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;

        var shiftHeld = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
        var act = Decide(isDown, isUp, data.vkCode, winHeld, shiftHeld, injected, Environment.TickCount64);
        if (act == Act.Pass) return CallNextHookEx(_hook, nCode, wParam, lParam);

        if (act == Act.Toggle)
        {
            // The shell opens Start when Win is released having seen no other key.
            // We swallowed the real one, so inject a harmless Ctrl tap to make the
            // Win press count as part of a combination.
            //
            // FIRST, where it used to be last. This injects input, and input is
            // what the foreground rules are keyed on: doing it after the grant
            // meant the last thing Windows saw before Wumpy asked for the
            // keyboard was a keystroke belonging to whatever was underneath.
            // Nothing is lost by moving it - the Win key is still held.
            SuppressStartMenu();

            // Still issued, because when it works it is the cheapest route and
            // costs nothing when it does not. No longer relied on: see
            // Activate, which is what the panel actually waits for now.
            var granted = _grantPid != 0 && AllowSetForegroundWindow(_grantPid);

            Console.WriteLine(granted ? "TOGGLE granted" : "TOGGLE ungranted");
            Console.Out.Flush();
        }

        return 1; // swallow: the shell never sees it
    }

    /// <summary>
    /// That the activation imports resolve at all.
    ///
    /// A misspelled DllImport throws EntryPointNotFoundException on the first
    /// call and not before - which for these would be the moment the hotkey
    /// is pressed, on a background thread, with the output going to a pipe
    /// nobody was reading. Every call here is a deliberate no-op: detaching
    /// nothing, activating the desktop's idea of no window.
    /// </summary>
    private static bool ForegroundSelfTest()
    {
        try
        {
            AttachThreadInput(0, 0, false);
            SetForegroundWindow(IntPtr.Zero);
            BringWindowToTop(IntPtr.Zero);
            IsWindowVisible(IntPtr.Zero);
            GetWindowThreadProcessId(GetForegroundWindow(), out _);
            SwitchToThisWindow(IntPtr.Zero, true);
            AllowSetForegroundWindow(0);
            return true;
        }
        catch (Exception err)
        {
            Console.Error.WriteLine($"  foreground FAIL: {err.GetType().Name} {err.Message}");
            return false;
        }
    }

    /* ----------------------------------------------------------- activation */

    /// <summary>
    /// Give a window the keyboard, from the process that received the key.
    ///
    /// Three attempts at autofocus were spent in the renderer and two in the
    /// main process, all of them downstream of the real problem: by the time
    /// Wumpy can act, the right to change the foreground has moved on. This
    /// runs where that right still exists.
    ///
    /// On its own thread, deliberately. AttachThreadInput merges two input
    /// queues, and a SetForegroundWindow made across a merged queue can block
    /// if the other side is not pumping messages. A wedged activation must
    /// not take the hook down with it - without the hook, the hotkey stops
    /// working altogether, which is far worse than a panel that opens deaf.
    /// </summary>
    private static void Activate(IntPtr hwnd) => Raiser(hwnd, report: true).Start();

    /// <summary>
    /// The same activation, done now, with an answer.
    /// </summary>
    /// <remarks>
    /// A PLAN NEEDS THIS AS MUCH AS THE PANEL DOES, and for a reason that took
    /// a day of empty compose windows to see: characters follow the FOREGROUND
    /// window, and the window a plan acts on is deliberately not it.
    ///
    /// `Target` walks under Wumpy's own panel on purpose, so every UIA call -
    /// press, select, read - lands in the user's window while the panel keeps
    /// the keyboard. That is right for all of them except the one that is
    /// about the keyboard. FOCUS set the UIA focus in a background Edge,
    /// Chromium honoured it and reported HasKeyboardFocus=true, and the
    /// ctrl+a and ctrl+v that followed went to whatever was actually in front.
    /// "The characters went somewhere else" was literally true.
    ///
    /// Silent, because this runs inside a FOCUS and the reply to a command is
    /// one line; what happened is reported there as `fg=`. Bounded, because
    /// the caller is a command the app is waiting on, and joined with a
    /// timeout for the same reason the panel's copy runs on a thread: a
    /// SetForegroundWindow across merged input queues can block, and a wedge
    /// here must cost one slow step rather than the hotkey.
    /// </remarks>
    internal static bool RaiseNow(IntPtr hwnd, int ms)
    {
        if (hwnd == IntPtr.Zero) return false;
        if (GetForegroundWindow() == hwnd) return true;
        var worker = Raiser(hwnd, report: false);
        worker.Start();
        worker.Join(ms);
        return GetForegroundWindow() == hwnd;
    }

    private static Thread Raiser(IntPtr hwnd, bool report)
    {
        var worker = new Thread(() =>
        {
            var joined = false;
            var returned = false;
            var error = 0;
            var attempts = 0;
            try
            {
                if (hwnd == IntPtr.Zero || !IsWindowVisible(hwnd))
                {
                    if (!report) return;
                    Console.WriteLine("ACTIVATE skipped window-not-visible");
                    Console.Out.Flush();
                    return;
                }

                /*
                 * Two different levers, because one is not enough.
                 *
                 * Attach-and-set is the documented route and it is the one
                 * that can be refused - measured on a real show, it returned
                 * false with the input queues successfully joined.
                 * SwitchToThisWindow is not subject to the foreground rules
                 * at all. Trying the polite one first means the forceful one
                 * only runs when it is needed, and reporting which one won
                 * means the next person to touch this does not have to guess.
                 */
                /*
                 * The usual answer, and it reads as one in the log.
                 *
                 * Measured over real hotkey presses: the panel already holds
                 * the foreground by the time this runs, every time, so the
                 * loop breaks before pulling a lever. "nothing tried" was
                 * technically true and told the reader nothing.
                 */
                var after = "already foreground";
                for (attempts = 1; attempts <= 4; attempts++)
                {
                    if (GetForegroundWindow() == hwnd) break;

                    var fg = GetForegroundWindow();
                    if (attempts % 2 == 1)
                    {
                        var fgThread = GetWindowThreadProcessId(fg, out _);
                        var me = GetCurrentThreadId();
                        joined = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);

                        returned = SetForegroundWindow(hwnd);
                        error = returned ? 0 : Marshal.GetLastWin32Error();
                        BringWindowToTop(hwnd);

                        if (joined) AttachThreadInput(me, fgThread, false);
                        after = "attach+setfg";
                    }
                    else
                    {
                        SwitchToThisWindow(hwnd, true);
                        after = "switchtothiswindow";
                    }

                    Thread.Sleep(60);
                }

                var won = GetForegroundWindow() == hwnd;
                // `after`, not `via`: it names the last lever pulled, which is
                // not the same as the one that worked. Wumpy's own show() may
                // have won the foreground before any of this ran, and a label
                // claiming otherwise is how five fixes came to be believed.
                if (!report) return;
                Console.WriteLine(
                    $"ACTIVATE {(won ? "ok" : "FAILED")} after={after} " +
                    $"attempts={attempts} joined={joined} setfg={returned} err={error}");
                Console.Out.Flush();
            }
            catch (Exception err)
            {
                if (!report) return;
                Console.WriteLine($"ACTIVATE error {err.GetType().Name}");
                Console.Out.Flush();
            }
        })
        { IsBackground = true, Name = "activate" };
        return worker;
    }

    /* ------------------------------------------------------------- self-test */

    private const uint VK_X = 0x58;

    /// <summary>
    /// Drives whole key sequences through Decide and checks what came out.
    ///
    /// The thing being checked is that one press is one TOGGLE however long it
    /// is held. Auto-repeat is generated below the hook, so holding Win+C used
    /// to deliver around thirty presses a second and the panel toggled on each
    /// of them, which reads as flashing. It cannot be caught by pressing the
    /// key once, and it cannot be caught with SendInput either, because the
    /// hook ignores injected input by design - hence driving the decision
    /// directly.
    /// </summary>
    private static bool KeySelfTest()
    {
        var failed = 0;

        void Check(string what, bool ok)
        {
            if (!ok) failed++;
            if (!ok) Console.Error.WriteLine($"  keytest FAIL: {what}");
        }

        // Each scenario starts from nothing held.
        void Fresh() => _firedVk = 0;

        Act Down(uint vk, bool win, long now = 0) => Decide(true, false, vk, win, false, false, now);
        Act Up(uint vk, bool win, long now = 0) => Decide(false, true, vk, win, false, false, now);

        // A plain tap.
        Fresh();
        Check("a tap reports once", Down('C', true) == Act.Toggle);
        Check("the release is swallowed, not passed on", Up('C', true) == Act.Swallow);

        // Held down. This is the one that mattered.
        Fresh();
        var toggles = Down('C', true) == Act.Toggle ? 1 : 0;
        var leaked = 0;
        for (var i = 0; i < 40; i++)
        {
            var act = Down('C', true, 30 * (i + 1));
            if (act == Act.Toggle) toggles++;
            if (act == Act.Pass) leaked++;
        }
        Check("holding it reports exactly once", toggles == 1);
        Check("no repeat escapes to the app", leaked == 0);
        Check("and the release ends the press", Up('C', true, 2000) == Act.Swallow);

        // Letting Win go first leaves C repeating on its own. Those repeats are
        // the keystroke we swallowed, so they must not arrive as typed letters.
        Fresh();
        Check("press", Down('C', true) == Act.Toggle);
        var escaped = 0;
        for (var i = 0; i < 5; i++)
            if (Down('C', false, 30 * (i + 1)) != Act.Swallow) escaped++;
        Check("Win released first still swallows the repeats", escaped == 0);
        Check("and its release", Up('C', false, 200) == Act.Swallow);

        // Two deliberate presses are two toggles - the guard must not be sticky.
        Fresh();
        var pair = 0;
        if (Down('C', true, 0) == Act.Toggle) pair++;
        Up('C', true, 40);
        if (Down('C', true, 80) == Act.Toggle) pair++;
        Check("tapping twice toggles twice", pair == 2);

        // Typing the letter is untouched.
        Fresh();
        Check("C alone is passed through", Down('C', false) == Act.Pass);
        Check("and its release", Up('C', false) == Act.Pass);

        // The hardware Copilot key, which arrives as Win+F23.
        Fresh();
        Check("the Copilot key reports once", Down(VK_F23, true) == Act.Toggle);
        Check("its repeats are swallowed", Down(VK_F23, true, 30) == Act.Swallow);
        Check("its release too", Up(VK_F23, true, 60) == Act.Swallow);
        Fresh();
        Check("F23 without Win is not ours", Down(VK_F23, false) == Act.Pass);

        // Our own Ctrl tap must never come back round as a press.
        Fresh();
        Check("injected input is ignored", Decide(true, false, 'C', true, false, true, 0) == Act.Pass);

        // Win+Shift+W, the combination Wumpy asks for with `W --shift`.
        var savedVk = _targetVk;
        _targetVk = 'W';
        _requireShift = true;
        _firedVk = 0;
        Check("Win+W without Shift is not ours", Decide(true, false, 'W', true, false, false, 0) == Act.Pass);
        Check("Win+Shift+W reports once", Decide(true, false, 'W', true, true, false, 0) == Act.Toggle);
        Check("and its release is swallowed", Decide(false, true, 'W', true, true, false, 40) == Act.Swallow);
        Check("Shift+W without Win is typing", Decide(true, false, 'W', false, true, false, 100) == Act.Pass);
        _targetVk = savedVk;
        _requireShift = false;
        _firedVk = 0;

        // Other keys keep working during the hold.
        Fresh();
        Down('C', true);
        Check("another key still reaches the app", Down(VK_X, true, 30) == Act.Pass);

        // A release the hook never saw - a secure desktop, a hook dropped for
        // being slow - must not swallow the letter C for the rest of the session.
        Fresh();
        Check("press", Down('C', true, 0) == Act.Toggle);
        Check("a lost release expires", Down('C', false, HeldTimeoutMs + 1) == Act.Pass);

        // A genuine hold outlasts that timeout, because its repeats refresh it.
        Fresh();
        Down('C', true, 0);
        var held = 0;
        for (var i = 1; i <= 400; i++)
            if (Down('C', true, 30 * i) == Act.Toggle) held++;
        Check("a twelve-second hold still reports only the one press", held == 0);

        Fresh();
        return failed == 0;
    }

    /*
     * ------------------------------------------------------------------
     * Acting on the screen: moving the pointer, clicking, typing.
     *
     * Here rather than in Electron because this is the process that already
     * owns SendInput, with the union layout proved by --selftest and a
     * signature on every event so the hook ignores its own input. A second
     * implementation in a second place would be a second chance to get the
     * 40-byte INPUT struct wrong.
     *
     * Everything below takes REAL SCREEN PIXELS. The translation from what
     * the model saw in a screenshot is done in Electron, which is the only
     * side that knows which display was photographed and how far it was
     * scaled down.
     * ------------------------------------------------------------------
     */

    /*
     * One line in, one line out, always.
     *
     * Every branch prints exactly one reply beginning with the verb it was
     * given, because the Electron side matches replies to requests by that
     * first word. A command that silently did nothing would leave the caller
     * waiting on a promise that never settles, which is worse on screen than
     * a click that failed and said so.
     */
    private static void Command(string text)
    {
        var space = text.IndexOf(' ');
        var verb = (space < 0 ? text : text[..space]).ToUpperInvariant();
        var rest = space < 0 ? string.Empty : text[(space + 1)..].Trim();

        switch (verb)
        {
            case "MOVE":
            case "CLICK":
            {
                /* "<x> <y> [left|right] [times]" */
                var bits = rest.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (bits.Length < 2 || !int.TryParse(bits[0], out var x) || !int.TryParse(bits[1], out var y))
                {
                    Console.WriteLine($"{verb} FAILED bad-coordinates");
                    return;
                }
                if (verb == "MOVE") { Move(x, y); return; }
                var right = bits.Length > 2 && bits[2].Equals("right", StringComparison.OrdinalIgnoreCase);
                var times = bits.Length > 3 && int.TryParse(bits[3], out var t) ? Math.Clamp(t, 1, 3) : 1;
                Click(x, y, right, times);
                return;
            }
            case "TYPE":
            {
                /*
                 * Base64, because the text is arbitrary and this is a
                 * line protocol: a newline or a stray carriage return in the
                 * payload would end the command half way through and leave
                 * the remainder to be read as the next one.
                 */
                try
                {
                    Type(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(rest)));
                }
                catch (FormatException)
                {
                    Console.WriteLine("TYPE FAILED not-base64");
                }
                return;
            }
            case "KEY":
                Key(rest);
                return;
            case "SCROLL":
            {
                /* "<x> <y> <notches>" - positive notches scroll DOWN, which
                   is the direction a reader means by "scroll down". */
                var bits = rest.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (bits.Length < 3
                    || !int.TryParse(bits[0], out var sx)
                    || !int.TryParse(bits[1], out var sy)
                    || !int.TryParse(bits[2], out var notches))
                {
                    Console.WriteLine("SCROLL FAILED bad-arguments");
                    return;
                }
                Scroll(sx, sy, notches);
                return;
            }
            case "GUARD":
                Guard();
                return;
            case "FOCUSED":
                /*
                 * Who has the keyboard, for the step that clicks into prose.
                 *
                 * No argument: the answer is about the machine's own state
                 * rather than about anything named. A read, like GUARD.
                 */
                UiTree.Focused();
                return;
            case "ELEMENTS":
            {
                /* "[limit] [filter words]" - the filter narrows a busy page. */
                var bits = rest.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
                var limit = bits.Length > 0 && int.TryParse(bits[0], out var n) ? Math.Clamp(n, 1, 200) : 60;
                UiTree.Elements(bits.Length > 1 ? bits[1].Trim() : string.Empty, limit);
                return;
            }
            case "PRESS":
            case "FOCUS":
            {
                /* Base64, because a control is named things like
                   "To recipients, Press Delete to remove". */
                try
                {
                    var name = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(rest));
                    UiTree.Press(name, verb == "FOCUS", verb);
                }
                catch (FormatException)
                {
                    Console.WriteLine($"{verb} FAILED not-base64");
                }
                return;
            }
            case "VALUE":
            case "REVEAL":
            {
                /*
                 * Reading a control back, and bringing one into view.
                 *
                 * VALUE is how a plan checks its own work without spending a
                 * screenshot on it: type into the To box, read the To box,
                 * see whether "Stanley" is in it. A screenshot is ~1,100
                 * tokens of a scarce free tier and has to be looked at by the
                 * model; this is a string.
                 *
                 * REVEAL scrolls a named control into view through UI
                 * Automation, so nothing below the fold needs a wheel and the
                 * pointer is never touched.
                 */
                try
                {
                    var name = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(rest));
                    if (verb == "VALUE") UiTree.Value(name);
                    else UiTree.Reveal(name);
                }
                catch (FormatException)
                {
                    Console.WriteLine($"{verb} FAILED not-base64");
                }
                return;
            }
            case "":
                return;
            default:
                Console.WriteLine($"{verb} FAILED unknown-command");
                return;
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);

    /// <summary>
    /// Is anyone else using this computer right now?
    ///
    /// Three facts, cheap enough to ask between every step of a plan:
    /// which window has the keyboard, where the pointer is, and how long
    /// ago the user last pressed a key themselves.
    ///
    /// The caller compares them against what it saw when the plan started.
    /// A changed foreground window means the plan is now aiming at
    /// something else - the page navigated, a dialog opened, the user
    /// alt-tabbed - and the remaining clicks would land in a stranger's
    /// window. A pointer that moved somewhere nobody put it, or a keystroke
    /// nobody synthesised, means the person is using the machine.
    ///
    /// None of it is a judgement. It is the evidence, reported, and the
    /// decision is made where the plan is.
    /// </summary>
    private static void Guard()
    {
        var hwnd = GetForegroundWindow();
        var title = new System.Text.StringBuilder(256);
        GetWindowTextW(hwnd, title, title.Capacity);
        GetCursorPos(out var at);
        /* Milliseconds since the user's own last keypress, or -1 for never. */
        var since = _lastRealKey == 0 ? -1 : Environment.TickCount64 - _lastRealKey;
        /*
         * And since their last click, which used to be invisible from here.
         * A click is how someone takes the machine back without moving the
         * pointer far enough to notice or pressing a key at all.
         */
        var clickMs = _lastRealClick == 0 ? -1 : Environment.TickCount64 - _lastRealClick;
        /*
         * And whether the window in front is Wumpy's own, with the name of
         * the one a plan would act on instead.
         *
         * It usually IS Wumpy's: the user summons the panel, types, and
         * presses Enter. Nothing said so before, and the consequence was a
         * plan looking up control names inside Wumpy's own transcript -
         * plus a guard that read the plan's own first click, which activates
         * the window it clicked in, as the user coming back to the machine.
         */
        Console.WriteLine(
            $"GUARD ok hwnd={hwnd.ToInt64()} cursor={at.x},{at.y} keyms={since} " +
            $"clickms={clickMs} click={(_lastClickWhat.Length > 0 ? _lastClickWhat : "none")} " +
            $"mousehook={(_mouseHook == IntPtr.Zero ? "off" : "on")} " +
            $"own={(UiTree.ForegroundIsOurs() ? "yes" : "no")} " +
            $"target={Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(UiTree.TargetTitle()))} " +
            $"title={Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(title.ToString()))}");
    }

    /// <summary>Moves the pointer and reports where it actually landed.</summary>
    private static void Move(int x, int y)
    {
        var moved = SetCursorPos(x, y);
        var err = moved ? 0 : Marshal.GetLastWin32Error();
        /* Read it back rather than trusting the return: the pointer is
           clamped to the virtual desktop, so asking for a point off-screen
           succeeds and lands somewhere else entirely. */
        GetCursorPos(out var at);
        var landed = moved && at.x == x && at.y == y;
        Console.WriteLine(
            $"MOVE {(landed ? "ok" : "CLAMPED")} at={at.x},{at.y} set={moved} err={err}");
    }

    private static void Click(int x, int y, bool right, int times)
    {
        /*
         * Where the pointer was, so it can be put back.
         *
         * "don't make it use MY cursor". PRESS by name does not touch it at
         * all and is what the model is told to prefer; a coordinate click
         * genuinely has to move it, because a synthesised button press lands
         * wherever the pointer is. The next best thing is to leave it where
         * it was found, so the user's pointer is borrowed for a moment
         * rather than taken.
         */
        var had = GetCursorPos(out var before);

        if (!SetCursorPos(x, y))
        {
            Console.WriteLine($"CLICK FAILED cursor err={Marshal.GetLastWin32Error()}");
            return;
        }
        GetCursorPos(out var at);
        if (at.x != x || at.y != y)
        {
            /* Off-screen, so the click would land on whatever the pointer was
               clamped to. That is how an automated click hits the wrong
               window, so it does not happen. */
            Console.WriteLine($"CLICK REFUSED off-screen asked={x},{y} landed={at.x},{at.y}");
            return;
        }

        var down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        var up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        uint sent = 0;
        for (var i = 0; i < times; i++)
        {
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].mi = new MOUSEINPUT { dwFlags = down, dwExtraInfo = WumpySignature };
            inputs[1].type = INPUT_MOUSE;
            inputs[1].mi = new MOUSEINPUT { dwFlags = up, dwExtraInfo = WumpySignature };
            sent += SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        }
        var want = (uint)(times * 2);
        var err = sent == want ? 0 : Marshal.GetLastWin32Error();

        /*
         * Put back after the button events, not before: moving the pointer
         * away first would make the click land where the pointer ended up.
         * Whatever happened above, including a failure.
         */
        var restored = had && SetCursorPos(before.x, before.y);

        Console.WriteLine(
            sent == want
                ? $"CLICK ok at={x},{y} button={(right ? "right" : "left")} times={times} " +
                  $"pointer={(restored ? "restored" : "left-there")}"
                : $"CLICK FAILED sent={sent}/{want} err={err}");
    }

    /// <summary>
    /// Turns the wheel under a point, for the things UI Automation cannot
    /// scroll.
    ///
    /// REVEAL is the first choice and does not touch the pointer at all.
    /// This is the fallback for a canvas, a map, a custom list - anything
    /// that scrolls without exposing a scroll pattern. A wheel event goes to
    /// whatever is under the cursor, so the cursor has to be there; it is
    /// borrowed and put back, exactly as a coordinate click does.
    ///
    /// Positive notches scroll DOWN, because that is what "scroll down"
    /// means to the person asking. Windows counts the other way, so the sign
    /// is flipped here once rather than in every caller.
    /// </summary>
    private static void Scroll(int x, int y, int notches)
    {
        var steps = Math.Clamp(notches, -10, 10);
        if (steps == 0)
        {
            Console.WriteLine("SCROLL ok notches=0 nothing-to-do");
            return;
        }

        var had = GetCursorPos(out var before);
        if (!SetCursorPos(x, y))
        {
            Console.WriteLine($"SCROLL FAILED cursor err={Marshal.GetLastWin32Error()}");
            return;
        }
        GetCursorPos(out var at);
        if (at.x != x || at.y != y)
        {
            Console.WriteLine($"SCROLL REFUSED off-screen asked={x},{y} landed={at.x},{at.y}");
            return;
        }

        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].mi = new MOUSEINPUT
        {
            dwFlags = MOUSEEVENTF_WHEEL,
            /* Negated: Windows scrolls up on a positive delta. */
            mouseData = unchecked((uint)(-steps * WHEEL_DELTA)),
            dwExtraInfo = WumpySignature
        };
        var sent = SendInput(1, inputs, Marshal.SizeOf<INPUT>());
        var err = sent == 1 ? 0 : Marshal.GetLastWin32Error();
        var restored = had && SetCursorPos(before.x, before.y);

        Console.WriteLine(
            sent == 1
                ? $"SCROLL ok at={x},{y} notches={steps} " +
                  $"direction={(steps > 0 ? "down" : "up")} " +
                  $"pointer={(restored ? "restored" : "left-there")}"
                : $"SCROLL FAILED sent={sent}/1 err={err}");
    }

    /*
     * Typing, as Unicode code points rather than virtual keys.
     *
     * A virtual-key press means something different on every keyboard
     * layout, so 'z' typed by VK on a German layout is 'y'. KEYEVENTF_UNICODE
     * carries the character itself and is layout-independent; it is also the
     * only way to type anything that is not on the user's keyboard at all.
     *
     * Surrogate pairs go as two events, which is what the API wants: each
     * half is sent as its own UTF-16 unit and Windows recombines them.
     */
    private static void Type(string text)
    {
        if (!Keyboard(out var why)) { Console.WriteLine($"TYPE FAILED {why}"); return; }
        var events = new List<INPUT>(text.Length * 2);
        foreach (var unit in text)
        {
            foreach (var up in new[] { false, true })
            {
                var input = new INPUT { type = INPUT_KEYBOARD };
                input.ki = new KEYBDINPUT
                {
                    wVk = 0,
                    wScan = unit,
                    dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0),
                    dwExtraInfo = WumpySignature
                };
                events.Add(input);
            }
        }
        if (events.Count == 0)
        {
            Console.WriteLine("TYPE ok chars=0");
            return;
        }
        var arr = events.ToArray();
        var sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
        Console.WriteLine(
            sent == arr.Length
                ? $"TYPE ok chars={text.Length}"
                : $"TYPE FAILED sent={sent}/{arr.Length} err={Marshal.GetLastWin32Error()}");
    }

    /// <summary>
    /// Refuses to type while Wumpy's own panel holds the keyboard.
    /// </summary>
    /// <remarks>
    /// SendInput goes to the foreground window, whatever any step thought it
    /// was aiming at. The panel is usually the foreground window - the user
    /// summons it, types a request and presses Enter - so a plan that types
    /// without focusing first types into the panel, and the report says ok
    /// because the characters really were sent.
    ///
    /// That is how "stanley" ended up anywhere but the To field. The guard is
    /// on the last step before the keys leave, rather than on the step that
    /// should have focused, because this is the only place that knows where
    /// they will actually land.
    ///
    /// FOCUS and FILL now bring the window forward themselves, so this fires
    /// only for a plan that types at a window it never focused - which is the
    /// case worth refusing rather than performing.
    /// </remarks>
    private static bool Keyboard(out string why)
    {
        if (!UiTree.ForegroundIsOurs())
        {
            why = string.Empty;
            return true;
        }
        why = "wumpy-has-the-keyboard - Wumpy's own panel is in front, so these characters would " +
              "be typed into it, not into the window you mean. Focus the box first (focus, or " +
              "fill which does both), which brings that window forward - or, for writing with " +
              "no box around it, caret X Y, which clicks into the text and says what it reached.";
        return false;
    }

    /// <summary>The named keys that are not characters, plus modifiers.</summary>
    private static readonly Dictionary<string, ushort> NamedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["enter"] = 0x0D, ["return"] = 0x0D, ["tab"] = 0x09, ["escape"] = 0x1B, ["esc"] = 0x1B,
        ["backspace"] = 0x08, ["delete"] = 0x2E, ["space"] = 0x20, ["home"] = 0x24, ["end"] = 0x23,
        ["pageup"] = 0x21, ["pagedown"] = 0x22, ["up"] = 0x26, ["down"] = 0x28,
        ["left"] = 0x25, ["right"] = 0x27,
        ["ctrl"] = 0x11, ["control"] = 0x11, ["shift"] = 0x10, ["alt"] = 0x12, ["win"] = 0x5B,
        ["f1"] = 0x70, ["f2"] = 0x71, ["f3"] = 0x72, ["f4"] = 0x73, ["f5"] = 0x74, ["f6"] = 0x75,
        ["f11"] = 0x7A, ["f12"] = 0x7B
    };

    /// <summary>
    /// A chord: "ctrl+a", "alt+tab", "enter". Modifiers held, last key tapped.
    /// </summary>
    /// <remarks>
    /// A trailing count repeats it - "backspace 12" - and the repeats go in
    /// ONE SendInput call rather than twelve commands down the pipe.
    ///
    /// Asked for by the user, who wanted a box emptied the way a person
    /// empties one: "maybe Control A works, I'm not sure, but you know, just
    /// better backspace." They are right that it is the safer key. It is only
    /// usable in bulk, though, because emptying a field means one press per
    /// character, and a round trip apiece would make clearing a sentence
    /// slower than retyping it.
    ///
    /// Capped at 400, which is well past any field worth clearing this way
    /// and short of a stuck repeat doing real damage somewhere unintended.
    /// </remarks>
    private static void Key(string line)
    {
        if (!Keyboard(out var why)) { Console.WriteLine($"KEY FAILED {why}"); return; }
        var chord = line.Trim();
        var times = 1;
        var space = chord.LastIndexOf(' ');
        if (space > 0 && int.TryParse(chord.AsSpan(space + 1), out var asked))
        {
            if (asked < 1 || asked > 400)
            {
                Console.WriteLine($"KEY FAILED repeat-out-of-range={asked}");
                return;
            }
            times = asked;
            chord = chord[..space].Trim();
        }
        var parts = chord.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var codes = new List<ushort>();
        foreach (var part in parts)
        {
            if (NamedKeys.TryGetValue(part, out var vk)) codes.Add(vk);
            else if (part.Length == 1) codes.Add(char.ToUpperInvariant(part[0]));
            else
            {
                Console.WriteLine($"KEY FAILED unknown={part}");
                return;
            }
        }
        if (codes.Count == 0)
        {
            Console.WriteLine("KEY FAILED empty");
            return;
        }

        /* Down in order, up in reverse, so a modifier is still held when the
           key it modifies is pressed and released. */
        var events = new List<INPUT>();
        for (var press = 0; press < times; press++)
        {
            foreach (var vk in codes) events.Add(KeyEvent(vk, false));
            for (var i = codes.Count - 1; i >= 0; i--) events.Add(KeyEvent(codes[i], true));
        }

        var arr = events.ToArray();
        var sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
        var what = times > 1 ? $"{chord} x{times}" : chord;
        Console.WriteLine(
            sent == arr.Length
                ? $"KEY ok chord={what}"
                : $"KEY FAILED sent={sent}/{arr.Length} chord={what} err={Marshal.GetLastWin32Error()}");
    }

    private static INPUT KeyEvent(ushort vk, bool up)
    {
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.ki = new KEYBDINPUT
        {
            wVk = vk,
            dwFlags = up ? KEYEVENTF_KEYUP : 0,
            dwExtraInfo = WumpySignature
        };
        return input;
    }

    /// <summary>Returns the number of events SendInput accepted; 2 means the layout is right.</summary>
    private static uint SendInputSelfTest() => SendStartMenuBreaker();

    /*
     * Proves the pointer can be moved and put back, without clicking on
     * anything. A click self-test would have to click on something real.
     */
    private static string PointerSelfTest()
    {
        if (!GetCursorPos(out var was)) return "FAIL";
        var target = new POINT { x = was.x + 1, y = was.y + 1 };
        /*
         * Three tries, because this fails for reasons that are not ours.
         *
         * Windows refuses cursor control to a process below the integrity
         * level of whatever currently holds the foreground, so an elevated
         * window being focused at the wrong moment makes SetCursorPos
         * return false with no error code. Observed exactly that, twice,
         * minutes apart, with the same binary working in between.
         */
        for (var i = 0; i < 3; i++)
        {
            if (SetCursorPos(target.x, target.y) && GetCursorPos(out var now)
                && now.x == target.x && now.y == target.y)
            {
                SetCursorPos(was.x, was.y);
                return "ok";
            }
            Thread.Sleep(60);
        }
        SetCursorPos(was.x, was.y); // exactly where it was, whatever happened
        /*
         * "blocked", not "FAIL". The P/Invoke resolved and the call was
         * made; something outside this process declined it. Reported so it
         * is visible, and not counted as a failure, because a self-test
         * that goes red when an admin window happens to be focused is a
         * test nobody will believe the next time it is red.
         */
        return "blocked";
    }

    private static void SuppressStartMenu() => SendStartMenuBreaker();

    private static uint SendStartMenuBreaker()
    {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki = new KEYBDINPUT { wVk = VK_CONTROL, dwExtraInfo = WumpySignature };
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].ki = new KEYBDINPUT
        {
            wVk = VK_CONTROL,
            dwFlags = KEYEVENTF_KEYUP,
            dwExtraInfo = WumpySignature
        };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }
}
