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
using System.Runtime.InteropServices;

internal static class Program
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYUP = 0x0105;
    private const int HC_ACTION = 0;

    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;
    private const int VK_CONTROL = 0x11;
    private const int VK_F23 = 0x86;

    private const uint LLKHF_INJECTED = 0x10;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;

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

    // Held in a static field so the GC cannot collect the delegate the OS holds.
    private static readonly HookProc Callback = OnKey;
    private static IntPtr _hook = IntPtr.Zero;
    private static uint _mainThreadId;

    /// <summary>Process allowed to take the foreground, or 0 for none.</summary>
    private static uint _grantPid;

    /// <summary>Virtual-key code to intercept while a Windows key is held.</summary>
    private static uint _targetVk = 'C';

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
        }

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
            var fgOk = ForegroundSelfTest();
            Console.WriteLine(
                $"hook={(hookOk ? "ok" : "FAIL")} " +
                $"sizeof(INPUT)={Marshal.SizeOf<INPUT>()} " +
                $"sendinput={(sent == 2 ? "ok" : $"FAIL(sent={sent}, err={err})")} " +
                $"keys={(keysOk ? "ok" : "FAIL")} " +
                $"foreground={(fgOk ? "ok" : "FAIL")}");
            return hookOk && sent == 2 && keysOk && fgOk ? 0 : 1;
        }

        _mainThreadId = GetCurrentThreadId();

        _hook = SetWindowsHookExW(WH_KEYBOARD_LL, Callback, GetModuleHandleW(null), 0);
        if (_hook == IntPtr.Zero)
        {
            Console.Error.WriteLine($"FATAL SetWindowsHookEx failed: {Marshal.GetLastWin32Error()}");
            return 1;
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
    private static Act Decide(bool isDown, bool isUp, uint vkCode, bool winHeld, bool injected, long now)
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
        if (!((winHeld && vkCode == _targetVk) || isCopilotKey)) return Act.Pass;

        _firedVk = vkCode;
        _firedAt = now;
        return Act.Toggle;
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

        var winHeld = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0
                      || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;

        var act = Decide(isDown, isUp, data.vkCode, winHeld, injected, Environment.TickCount64);
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
    private static void Activate(IntPtr hwnd)
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
                Console.WriteLine(
                    $"ACTIVATE {(won ? "ok" : "FAILED")} after={after} " +
                    $"attempts={attempts} joined={joined} setfg={returned} err={error}");
                Console.Out.Flush();
            }
            catch (Exception err)
            {
                Console.WriteLine($"ACTIVATE error {err.GetType().Name}");
                Console.Out.Flush();
            }
        })
        { IsBackground = true, Name = "activate" };
        worker.Start();
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

        Act Down(uint vk, bool win, long now = 0) => Decide(true, false, vk, win, false, now);
        Act Up(uint vk, bool win, long now = 0) => Decide(false, true, vk, win, false, now);

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
        Check("injected input is ignored", Decide(true, false, 'C', true, true, 0) == Act.Pass);

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

    /// <summary>Returns the number of events SendInput accepted; 2 means the layout is right.</summary>
    private static uint SendInputSelfTest() => SendStartMenuBreaker();

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
