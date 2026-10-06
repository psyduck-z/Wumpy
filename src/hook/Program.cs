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

    /// <summary>Virtual-key code to intercept while a Windows key is held.</summary>
    private static uint _targetVk = 'C';

    private static int Main(string[] args)
    {
        // Accept a single letter or a raw 0x.. virtual-key code.
        if (args.Length > 0 && args[0].Length > 0)
        {
            var a = args[0];
            _targetVk = a.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToUInt32(a[2..], 16)
                : char.ToUpperInvariant(a[0]);
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
            Console.WriteLine(
                $"hook={(hookOk ? "ok" : "FAIL")} " +
                $"sizeof(INPUT)={Marshal.SizeOf<INPUT>()} " +
                $"sendinput={(sent == 2 ? "ok" : $"FAIL(sent={sent}, err={err})")}");
            return hookOk && sent == 2 ? 0 : 1;
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

        // Die with the parent: when Electron closes the pipe, stdin hits EOF.
        var watchdog = new Thread(() =>
        {
            try
            {
                using var stdin = Console.OpenStandardInput();
                var buf = new byte[1];
                while (stdin.Read(buf, 0, 1) > 0) { }
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

    private static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode != HC_ACTION) return CallNextHookEx(_hook, nCode, wParam, lParam);

        var msg = (int)wParam;
        if (msg != WM_KEYDOWN && msg != WM_SYSKEYDOWN)
            return CallNextHookEx(_hook, nCode, wParam, lParam);

        var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);

        // Never react to input we injected ourselves.
        if (data.dwExtraInfo == WumpySignature || (data.flags & LLKHF_INJECTED) != 0)
            return CallNextHookEx(_hook, nCode, wParam, lParam);

        var winHeld = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0
                      || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;

        // The dedicated Copilot key reports as Shift+Win+F23 rather than its own code.
        var isCopilotKey = data.vkCode == VK_F23 && winHeld;

        if ((winHeld && data.vkCode == _targetVk) || isCopilotKey)
        {
            Console.WriteLine("TOGGLE");
            Console.Out.Flush();

            // The shell opens Start when Win is released having seen no other key.
            // We swallowed the real one, so inject a harmless Ctrl tap to make the
            // Win press count as part of a combination.
            SuppressStartMenu();

            return 1; // swallow: the shell never sees it
        }

        return CallNextHookEx(_hook, nCode, wParam, lParam);
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
