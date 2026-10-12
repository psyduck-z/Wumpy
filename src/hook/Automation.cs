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

    /// <summary>The foreground window, which is the one the user is looking at.</summary>
    private static AutomationElement? ForegroundTree()
    {
        var hwnd = NativeForeground();
        if (hwnd == IntPtr.Zero) return null;
        try { return AutomationElement.FromHandle(hwnd); }
        catch { return null; }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private static IntPtr NativeForeground() => GetForegroundWindow();

    private static List<Found> Collect(AutomationElement root, int limit)
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

            if (string.IsNullOrWhiteSpace(name) || !enabled || offscreen) continue;
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
        var root = ForegroundTree();
        if (root is null)
        {
            Console.WriteLine("ELEMENTS FAILED no-foreground-window");
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

        /* Interactive things first: a page has far more Text than Button and
           the buttons are what a plan is usually reaching for. */
        var ordered = found
            .OrderBy(f => f.Role is "Text" or "Document" ? 1 : 0)
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
        Console.WriteLine($"ELEMENTS ok count={ordered.Count} total={found.Count} {json}");
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
        var root = ForegroundTree();
        if (root is null)
        {
            Console.WriteLine($"{verb} FAILED no-foreground-window");
            return;
        }

        var best = Collect(root, 4000)
            .Select(f => (f, score: Score(f.Name, want)))
            .Where(t => t.score > 0)
            .OrderByDescending(t => t.score)
            .ThenBy(t => t.f.Role is "Text" or "Document" ? 1 : 0)
            .ThenBy(t => t.f.Y)
            .FirstOrDefault();

        if (best.f is null)
        {
            Console.WriteLine($"{verb} FAILED nothing-named {Encode(want)}");
            return;
        }

        var el = FindAgain(root, best.f);
        if (el is null)
        {
            Console.WriteLine($"{verb} FAILED element-vanished");
            return;
        }

        var where = $"{best.f.X + best.f.W / 2},{best.f.Y + best.f.H / 2}";
        var what = $"name={Encode(best.f.Name)} role={best.f.Role} at={where}";

        try
        {
            /*
             * Focus for anything that takes typing, Invoke for anything that
             * is pressed. An Edit that is Invoked does nothing useful, and a
             * Button that is only focused is not clicked - getting these the
             * wrong way round is a silent no-op, which is the failure this
             * whole file exists to stop.
             */
            if (focusOnly || best.f.Role is "Edit" or "ComboBox" or "Document")
            {
                el.SetFocus();
                Console.WriteLine($"{verb} ok via=focus {what}");
                return;
            }
            if (best.f.Invokable && el.TryGetCurrentPattern(InvokePattern.Pattern, out var pattern))
            {
                ((InvokePattern)pattern).Invoke();
                Console.WriteLine($"{verb} ok via=invoke {what}");
                return;
            }
            el.SetFocus();
            Console.WriteLine($"{verb} ok via=focus-fallback {what}");
        }
        catch (Exception ex)
        {
            /* Reported rather than swallowed, and with the element named, so
               the next attempt can pick a different one. */
            Console.WriteLine($"{verb} FAILED {ex.GetType().Name} {what}");
        }
    }

    /// <summary>
    /// Re-finds the element, because Collect's record is a snapshot.
    ///
    /// Matching on name AND position: a page can hold several controls with
    /// the same name, and the one that was chosen is the one at that spot.
    /// </summary>
    private static AutomationElement? FindAgain(AutomationElement root, Found f)
    {
        try
        {
            var byName = new PropertyCondition(AutomationElement.NameProperty, f.Name);
            var all = root.FindAll(TreeScope.Descendants, byName);
            foreach (AutomationElement e in all)
            {
                try
                {
                    var r = e.Current.BoundingRectangle;
                    if ((int)r.X == f.X && (int)r.Y == f.Y) return e;
                }
                catch { /* gone */ }
            }
            return all.Count > 0 ? all[0] : null;
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
