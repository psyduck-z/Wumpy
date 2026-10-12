using System.Text;
using System.Text.Json;
using System.Windows.Automation;

/// <summary>
/// Finding things on screen by their name, instead of guessing their pixel.
///
/// Reported after the first version shipped: "it keeps on missing the TO
/// fillin box, and keeps clicking the same place every time... don't
/// hardcode it."
///
/// Both halves of that have the same cause. A model reading a screenshot
/// that was scaled down to 1568px is estimating a coordinate, and an
/// estimate that is wrong is wrong identically every time it looks at the
/// same picture - so it misses, looks again, sees the same thing and misses
/// in exactly the same place. Nothing in a pixel loop breaks that cycle.
///
/// UI Automation does not estimate. Every control a Chromium page exposes
/// has a name, a role and a rectangle in real screen coordinates, so "the To
/// field" is a lookup rather than a guess. Measured on the live Gmail tab:
/// 971 elements in 256ms, 673 of them named.
///
/// It also answers the other request - "don't make it use MY cursor" -
/// because a control that supports the Invoke pattern can be pressed
/// directly. No pointer moves, nothing is taken away from the user's hand.
/// </summary>
internal static class UiTree
{
    /// <summary>
    /// The roles worth offering. A page has hundreds of Panes and Groups
    /// that exist only to hold other things, and listing them buries the
    /// handful of controls that can actually be used.
    /// </summary>
    private static readonly HashSet<string> Useful = new(StringComparer.Ordinal)
    {
        "Button", "Edit", "Hyperlink", "MenuItem", "TabItem", "CheckBox",
        "RadioButton", "ComboBox", "ListItem", "Document", "Text", "Tab", "SplitButton"
    };

    private sealed record Found(string Name, string Role, int X, int Y, int W, int H, bool Invokable);

    /// <summary>
    /// Wumpy's own process id, so its own windows can be told apart from the
    /// user's. Set from --grant-foreground, which the app already passes.
    /// </summary>
    public static uint Owner { get; set; }

    /// <summary>The last window we looked at that was not Wumpy's.</summary>
    private static IntPtr _lastForeign;

    /// <summary>Is this one of Wumpy's own windows?</summary>
    private static bool Ours(IntPtr hwnd)
    {
        if (Owner == 0 || hwnd == IntPtr.Zero) return false;
        GetWindowThreadProcessId(hwnd, out var pid);
        return pid == Owner;
    }

    /// <summary>
    /// The window a plan should act on - which is usually NOT the one in front.
    ///
    /// This is the bug that made the whole press-by-name feature look broken.
    /// The user summons the panel, types "go to my Gmail tab and click
    /// compose", and presses Enter: at that moment WUMPY has the foreground,
    /// so a lookup against the foreground window searches Wumpy's own
    /// transcript. From the log of a real attempt:
    ///
    ///   PRESS FAILED InvalidOperationException
    ///     name=UHJlc3MgIkluYm94IC0gemVjaGFyaWFoIg==  role=ListItem at=1698,547
    ///
    /// Decoded, that name is `Press "Inbox - zechariah"` - the text of
    /// Wumpy's own step card, at 1698,547, which is where the panel is. It
    /// found its own user interface and pressed that. The next attempt hit
    /// `element-vanished` for the same reason: the card re-rendered.
    ///
    /// The model was also handed those controls as "what is on screen" - 60
    /// of them, out of Wumpy's transcript - so it had no real names to use
    /// and fell back to estimating pixels off the screenshot, which is the
    /// ten-nudged-clicks loop in the same log. "It composed three things,
    /// didn't put anything inside the sender."
    ///
    /// So: never Wumpy. If the foreground belongs to this app, walk down the
    /// Z-order for the first real window underneath it, which is the one the
    /// user was in before they summoned the panel.
    /// </summary>
    private static IntPtr Target()
    {
        var fg = GetForegroundWindow();
        if (fg != IntPtr.Zero && !Ours(fg))
        {
            _lastForeign = fg;
            return fg;
        }

        for (var next = GetWindow(fg, GW_HWNDNEXT); next != IntPtr.Zero; next = GetWindow(next, GW_HWNDNEXT))
        {
            if (Ours(next) || !IsWindowVisible(next) || IsIconic(next)) continue;
            /* Tool windows are palettes and tooltips, not places to click. */
            if ((GetWindowLong(next, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) continue;
            if (GetWindowTextLength(next) == 0) continue;
            _lastForeign = next;
            return next;
        }

        /* Nothing underneath: the last real window we saw, or - if there has
           never been one - the foreground, even if that is Wumpy. Acting on
           the panel is wrong, and refusing to answer at all is worse. */
        if (_lastForeign != IntPtr.Zero && IsWindow(_lastForeign)) return _lastForeign;
        return fg;
    }

    /// <summary>The title of the window a plan would act on, for the report.</summary>
    public static string TargetTitle()
    {
        var hwnd = Target();
        if (hwnd == IntPtr.Zero) return string.Empty;
        var text = new StringBuilder(256);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    /// <summary>True when the window in front belongs to Wumpy itself.</summary>
    public static bool ForegroundIsOurs() => Ours(GetForegroundWindow());

    /// <summary>
    /// The accessibility tree of the window to act on.
    ///
    /// Named for what it is rather than for the foreground, because those
    /// stopped being the same thing the moment this app grew a window of its
    /// own that takes the keyboard.
    /// </summary>
    private static AutomationElement? TargetTree()
    {
        var hwnd = Target();
        if (hwnd == IntPtr.Zero) return null;
        try { return AutomationElement.FromHandle(hwnd); }
        catch { return null; }
    }

    private const uint GW_HWNDNEXT = 2;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    private static List<Found> Collect(AutomationElement root, int limit, bool includeOffscreen = false)
    {
        var found = new List<Found>();
        AutomationElementCollection all;
        try
        {
            all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        }
        catch
        {
            return found;
        }

        foreach (AutomationElement e in all)
        {
            if (found.Count >= limit) break;
            string name, role;
            System.Windows.Rect r;
            bool enabled, offscreen;
            try
            {
                var c = e.Current;
                name = c.Name;
                role = c.ControlType.ProgrammaticName.Replace("ControlType.", string.Empty);
                r = c.BoundingRectangle;
                enabled = c.IsEnabled;
                offscreen = c.IsOffscreen;
            }
            catch
            {
                continue; // an element that went away mid-walk
            }

            if (string.IsNullOrWhiteSpace(name) || !enabled) continue;
            /* Offscreen is skipped for a list of things to press, and kept
               for REVEAL, whose whole job is to bring one into view. */
            if (offscreen && !includeOffscreen) continue;
            if (!Useful.Contains(role)) continue;
            /* A zero or negative rectangle is a control that is not really
               there - Gmail parks offscreen labels at -12091,-12388. */
            if (r.Width < 2 || r.Height < 2 || double.IsInfinity(r.Width)) continue;

            var invokable = false;
            try { invokable = e.GetSupportedPatterns().Any(p => p.ProgrammaticName.Contains("Invoke")); }
            catch { /* some elements refuse the question */ }

            found.Add(new Found(
                name.Length > 80 ? name[..80] : name,
                role, (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height, invokable));
        }
        return found;
    }

    /// <summary>
    /// Everything usable in the foreground window, as JSON, for the model.
    ///
    /// This is what replaces guessing. The model is handed names and
    /// rectangles and picks one, so a click is a lookup and a miss is a
    /// wrong choice rather than a wrong estimate - which is the difference
    /// between a mistake it can correct and one it repeats.
    /// </summary>
    public static void Elements(string filter, int limit)
    {
        var root = TargetTree();
        if (root is null)
        {
            Console.WriteLine("ELEMENTS FAILED no-window-to-act-on");
            return;
        }

        var found = Collect(root, 4000);
        if (!string.IsNullOrWhiteSpace(filter))
        {
            found = found
                .Where(f => f.Name.Contains(filter, StringComparison.OrdinalIgnoreCase)
                         || f.Role.Contains(filter, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        /*
         * BOXES YOU CAN TYPE IN FIRST, then things you press, then text.
         *
         * The list is capped - sixty names is already most of a screenshot's
         * worth of tokens - and Gmail alone reports 971 elements, 673 of them
         * named. So what gets cut matters: under the old order (everything
         * interactive by Y, text last) the compose window's recipient box sat
         * below a whole left-hand navigation bar of buttons and could fall
         * off the end of the list entirely. The box you are about to fill in
         * is the single most useful thing on the list.
         */
        static int Rank(string role) => role switch
        {
            "Edit" or "ComboBox" => 0,
            "Text" or "Document" => 2,
            _ => 1
        };

        /*
         * And one entry per name per role.
         *
         * A mail list reports forty controls called "Select", a dozen called
         * "Unread". Repeats fill the cap with choices that cannot be told
         * apart - PRESS picks by name, so forty identical names are one
         * target, not forty - and they push the controls that are actually
         * distinct off the end.
         */
        var ordered = found
            .GroupBy(f => $"{f.Role}\u0000{f.Name}")
            .Select(g => g.First())
            .OrderBy(f => Rank(f.Role))
            .ThenBy(f => f.Y)
            .ThenBy(f => f.X)
            .Take(limit)
            .ToList();

        var json = JsonSerializer.Serialize(ordered.Select(f => new
        {
            name = f.Name,
            role = f.Role,
            x = f.X + f.W / 2,
            y = f.Y + f.H / 2,
            w = f.W,
            h = f.H
        }));
        /* Which window they came from, because once they came from Wumpy's
           own and nothing in the reply said so. The model is shown this. */
        Console.WriteLine(
            $"ELEMENTS ok count={ordered.Count} total={found.Count} " +
            $"window={Encode(TargetTitle())} {json}");
    }

    /// <summary>
    /// How well a candidate matches what was asked for. Higher is better,
    /// zero is no match at all.
    /// </summary>
    private static int Score(string name, string want)
    {
        if (name.Equals(want, StringComparison.OrdinalIgnoreCase)) return 100;
        if (name.StartsWith(want, StringComparison.OrdinalIgnoreCase)) return 80;
        if (name.Contains(want, StringComparison.OrdinalIgnoreCase)) return 60;
        /* Every word present, in any order: "To recipients" finds
           "To recipients, Press Delete to remove". */
        var words = want.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 1 && words.All(w => name.Contains(w, StringComparison.OrdinalIgnoreCase))) return 40;
        return 0;
    }

    /// <summary>
    /// Presses the named control, preferring Invoke so the pointer is left
    /// alone, and reports exactly which element it chose.
    ///
    /// Saying WHICH one matters as much as doing it. "clicked something
    /// called To recipients at 612,300" is correctable; "clicked" is not,
    /// and the complaint that started this was a loop of uncorrectable
    /// clicks.
    /// </summary>
    public static void Press(string want, bool focusOnly, string verb)
    {
        var root = TargetTree();
        if (root is null)
        {
            Console.WriteLine($"{verb} FAILED no-window-to-act-on");
            return;
        }

        /* FOCUS is about to be typed into, so it wants the box rather than
           the label beside it with the same name. */
        var chosen = Best(root, want, includeOffscreen: false, preferEditable: focusOnly);
        if (chosen is null)
        {
            Console.WriteLine($"{verb} FAILED nothing-named {Encode(want)}");
            return;
        }

        var el = FindAgain(root, chosen, out var exact);
        if (el is null)
        {
            Console.WriteLine($"{verb} FAILED element-vanished");
            return;
        }

        var where = $"{chosen.X + chosen.W / 2},{chosen.Y + chosen.H / 2}";
        /* `matched` says whether this is the control that was chosen or just
           another one with the same name, which is the difference between
           pressing a row and pressing a different row. */
        var what = $"name={Encode(chosen.Name)} role={chosen.Role} at={where} " +
                   $"matched={(exact ? "spot" : "name-only")}";

        try
        {
            /*
             * Focus for anything that takes typing, Invoke for anything that
             * is pressed. An Edit that is Invoked does nothing useful, and a
             * Button that is only focused is not clicked - getting these the
             * wrong way round is a silent no-op, which is the failure this
             * whole file exists to stop.
             */
            if (focusOnly || chosen.Role is "Edit" or "ComboBox" or "Document")
            {
                Console.WriteLine($"{verb} ok via=focus {what} focused={TakeFocus(el)}");
                return;
            }
            if (chosen.Invokable && el.TryGetCurrentPattern(InvokePattern.Pattern, out var pattern))
            {
                ((InvokePattern)pattern).Invoke();
                Console.WriteLine($"{verb} ok via=invoke {what}");
                return;
            }
            Console.WriteLine($"{verb} ok via=focus-fallback {what} focused={TakeFocus(el)}");
        }
        catch (Exception ex)
        {
            /* Reported rather than swallowed, and with the element named, so
               the next attempt can pick a different one. */
            Console.WriteLine($"{verb} FAILED {ex.GetType().Name} {what}");
        }
    }

    /// <summary>
    /// Puts the keyboard in a control, and says whether it actually went there.
    ///
    /// SetFocus returning without throwing is not evidence. The caller is
    /// about to send characters, and characters go to whatever holds the
    /// keyboard at that instant - so a focus that quietly did not take is
    /// how an email address ends up typed into a web page, where single
    /// letters are shortcuts. That is where the user's three empty compose
    /// windows came from: "it composed three things, didn't put anything
    /// inside the sender."
    ///
    /// So: ask, then check. HasKeyboardFocus is the question the next step
    /// actually depends on. When the answer is no and the control's window is
    /// not in front, the window is activated once and the answer is asked
    /// again - from a background process Windows may refuse that, and a
    /// refusal reported as "no" is worth far more than one reported as ok.
    /// </summary>
    private static string TakeFocus(AutomationElement el)
    {
        try { el.SetFocus(); }
        catch { /* reported as no, below */ }
        if (HasFocus(el)) return "yes";

        /* Second attempt, after bringing the window forward. */
        try
        {
            var hwnd = new IntPtr(el.Current.NativeWindowHandle);
            if (hwnd == IntPtr.Zero) hwnd = Target();
            if (hwnd != IntPtr.Zero && hwnd != GetForegroundWindow())
            {
                SetForegroundWindow(hwnd);
                try { el.SetFocus(); }
                catch { /* same */ }
            }
        }
        catch { /* and the same again */ }
        return HasFocus(el) ? "yes" : "no";
    }

    private static bool HasFocus(AutomationElement el)
    {
        try { return el.Current.HasKeyboardFocus; }
        catch { return false; }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    /// <summary>
    /// Reads a named control back, so a plan can check its own work.
    ///
    /// This is the cheap half of "look again between steps". Looking used to
    /// mean a screenshot: about 1,100 tokens of a free tier that runs out,
    /// plus a model deciding what it sees. Reading the To box after typing
    /// into it is a string comparison - and it is the exact question the
    /// failures were about ("it keeps on missing the TO fillin box"), asked
    /// directly instead of inferred from a picture.
    ///
    /// ValuePattern first, because that is what an Edit holds. Then the
    /// text pattern, then the name, because a Document and a Text report
    /// their contents in different places and a plan should not have to know
    /// which kind of control it is looking at.
    /// </summary>
    public static void Value(string want)
    {
        var root = TargetTree();
        if (root is null)
        {
            Console.WriteLine("VALUE FAILED no-window-to-act-on");
            return;
        }

        var best = Best(root, want);
        if (best is null)
        {
            Console.WriteLine($"VALUE FAILED nothing-named {Encode(want)}");
            return;
        }

        var el = FindAgain(root, best, out var exact);
        if (el is null)
        {
            Console.WriteLine("VALUE FAILED element-vanished");
            return;
        }

        var text = string.Empty;
        var via = "none";
        try
        {
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var value))
            {
                text = ((ValuePattern)value).Current.Value ?? string.Empty;
                via = "value";
            }
            else if (el.TryGetCurrentPattern(TextPattern.Pattern, out var textPattern))
            {
                text = ((TextPattern)textPattern).DocumentRange.GetText(4000) ?? string.Empty;
                via = "text";
            }
            else
            {
                text = best.Name;
                via = "name";
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VALUE FAILED {ex.GetType().Name} name={Encode(best.Name)}");
            return;
        }

        /* Trimmed, because a Document can hold the whole page and the caller
           is checking a field, not reading a book. */
        if (text.Length > 600) text = text[..600];
        Console.WriteLine(
            $"VALUE ok via={via} name={Encode(best.Name)} role={best.Role} " +
            $"matched={(exact ? "spot" : "name-only")} " +
            $"len={text.Length} text={Encode(text)}");
    }

    /// <summary>
    /// Scrolls a named control into view, without touching the pointer.
    ///
    /// Everything below the fold used to be out of reach: the elements list
    /// only reports what is on screen, so a Send button under the window's
    /// edge simply did not exist as far as a plan was concerned. ScrollItem
    /// is how a screen reader does this, and it asks the container to move
    /// rather than simulating a wheel over it.
    /// </summary>
    public static void Reveal(string want)
    {
        var root = TargetTree();
        if (root is null)
        {
            Console.WriteLine("REVEAL FAILED no-window-to-act-on");
            return;
        }

        /* Offscreen elements are skipped by Collect - that is right for a
           list of things to press and wrong here, since bringing an
           offscreen thing into view is the entire point. */
        var best = Best(root, want, includeOffscreen: true);
        if (best is null)
        {
            Console.WriteLine($"REVEAL FAILED nothing-named {Encode(want)}");
            return;
        }

        var el = FindAgain(root, best);
        if (el is null)
        {
            Console.WriteLine("REVEAL FAILED element-vanished");
            return;
        }

        try
        {
            if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out var scroll))
            {
                ((ScrollItemPattern)scroll).ScrollIntoView();
                var r = el.Current.BoundingRectangle;
                Console.WriteLine(
                    $"REVEAL ok name={Encode(best.Name)} role={best.Role} " +
                    $"at={(int)(r.X + r.Width / 2)},{(int)(r.Y + r.Height / 2)}");
                return;
            }
            Console.WriteLine($"REVEAL FAILED no-scroll-pattern name={Encode(best.Name)}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"REVEAL FAILED {ex.GetType().Name} name={Encode(best.Name)}");
        }
    }

    /// <summary>
    /// The best match for a name, shared by PRESS, VALUE and REVEAL so that
    /// all three choose the same element for the same words.
    /// </summary>
    private static Found? Best(
        AutomationElement root,
        string want,
        bool includeOffscreen = false,
        bool preferEditable = false)
    {
        /*
         * `preferEditable` is for FOCUS and FILL, where the caller is about
         * to type.
         *
         * A web page labels its fields: "To recipients" is the name of the
         * box AND the name of the text sitting beside it, and an exact match
         * on a label beats a partial match on the box - so the keyboard went
         * to a piece of static text, which cannot hold it. The characters
         * then go wherever the keyboard already was, which in Gmail means
         * single letters as shortcuts. Asked to put the cursor somewhere,
         * prefer the thing that takes a cursor.
         */
        var best = Collect(root, 4000, includeOffscreen)
            .Select(f => (f, score: Score(f.Name, want)))
            .Where(t => t.score > 0)
            .OrderByDescending(t => preferEditable && t.f.Role is "Edit" or "ComboBox" or "Document"
                ? t.score + 25
                : t.score)
            .ThenBy(t => t.f.Role is "Text" or "Document" ? 1 : 0)
            .ThenBy(t => t.f.Y)
            .FirstOrDefault();
        return best.f;
    }

    /// <summary>
    /// Re-finds the element, because Collect's record is a snapshot.
    ///
    /// Matching on name AND position: a page can hold several controls with
    /// the same name, and the one that was chosen is the one at that spot.
    /// </summary>
    private static AutomationElement? FindAgain(AutomationElement root, Found f) =>
        FindAgain(root, f, out _);

    /// <summary>
    /// The same, saying whether it is really the element that was chosen.
    ///
    /// The old fallback was `all[0]`: if nothing sat at the remembered spot it
    /// took the first control with that name and said nothing. That is a
    /// different control - possibly a different message, a different row, a
    /// different compose window - and it was reported as success. Worse for
    /// VALUE than for PRESS: `fill` proves itself by reading the box back, and
    /// reading a DIFFERENT box with the same name proves nothing at all.
    ///
    /// So: the nearest one, and the caller is told when it was not exact.
    /// </summary>
    private static AutomationElement? FindAgain(AutomationElement root, Found f, out bool exact)
    {
        exact = false;
        try
        {
            var byName = new PropertyCondition(AutomationElement.NameProperty, f.Name);
            var all = root.FindAll(TreeScope.Descendants, byName);
            AutomationElement? nearest = null;
            var bestGap = double.MaxValue;
            foreach (AutomationElement e in all)
            {
                try
                {
                    var r = e.Current.BoundingRectangle;
                    var gap = Math.Abs(r.X - f.X) + Math.Abs(r.Y - f.Y);
                    if ((int)r.X == f.X && (int)r.Y == f.Y)
                    {
                        exact = true;
                        return e;
                    }
                    if (gap < bestGap)
                    {
                        bestGap = gap;
                        nearest = e;
                    }
                }
                catch { /* gone */ }
            }
            /* A couple of pixels is the same control after a redraw; a hundred
               is a different one wearing the same name. */
            exact = nearest is not null && bestGap <= 4;
            return nearest ?? (all.Count > 0 ? all[0] : null);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Quoted, so a name with a space survives a line protocol.</summary>
    private static string Encode(string s) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(s));
}
