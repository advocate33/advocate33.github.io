using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Threading;
using SmartSwitcher.Core;

namespace SmartSwitcher.Desktop;

/// <summary>
/// Optional experimental low-level hook. Enabled only by an explicit user action.
/// Never logs keystrokes; retains at most 32 letters in volatile memory.
/// Allowed application: Windows Notepad only. No network access.
/// </summary>
internal sealed class KeyboardHook : IDisposable
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmSysKeyDown = 0x0104;
    private const int VkShift = 0x10;
    private const int VkControl = 0x11;
    private const int VkMenu = 0x12;
    private const int VkCapital = 0x14;
    private const int VkSpace = 0x20;
    private const int VkBack = 0x08;
    private const int VkF12 = 0x7b;
    private const int VkZ = 0x5a;
    private const uint LlkhfInjected = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public nuint dwExtraInfo;
    }

    private delegate nint HookProcedure(int nCode, nint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetWindowsHookExW(int idHook, HookProcedure callback, nint hMod, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook, int code, nint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern short GetKeyState(int nVirtKey);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandle(string? moduleName);

    private readonly CorrectionEngine _engine = new();
    private readonly StringBuilder _token = new(32);
    private readonly Dispatcher _dispatcher;
    private readonly HookProcedure _callback;
    private nint _hook;
    private ForegroundSnapshot _lastContext;
    private long _revision;
    private Rewrite? _lastRewrite;
    private bool _disposed;

    private sealed record Rewrite(ForegroundSnapshot Context, string Original, string Replacement);

    public event Action? ToggleRequested;
    public event Action<string>? Status;

    public KeyboardHook(Dispatcher dispatcher)
    {
        _dispatcher = dispatcher;
        _callback = ProcessKey;
        _hook = SetWindowsHookExW(WhKeyboardLl, _callback, GetModuleHandle(null), 0);
        if (_hook == 0)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Не удалось установить обработчик клавиатуры.");
    }

    private nint ProcessKey(int code, nint msg, nint info)
    {
        try { return ProcessKeyCore(code, msg, info); }
        catch
        {
            _token.Clear();
            _lastRewrite = null;
            ++_revision;
            return CallNextHookEx(_hook, code, msg, info);
        }
    }

    private nint ProcessKeyCore(int code, nint msg, nint info)
    {
        if (code < 0 || ((long)msg != WmKeyDown && (long)msg != WmSysKeyDown))
            return CallNextHookEx(_hook, code, msg, info);
        var key = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(info);
        if ((key.flags & LlkhfInjected) != 0)
            return CallNextHookEx(_hook, code, msg, info);
        int vk = checked((int)key.vkCode);
        bool ctrl = Pressed(VkControl);
        bool alt = Pressed(VkMenu);

        if (ctrl && alt && vk == VkF12)
        {
            _dispatcher.BeginInvoke(new Action(() => ToggleRequested?.Invoke()));
            return 1;
        }
        if (ctrl && alt && vk == VkZ && _lastRewrite is not null
            && ForegroundContext.Capture().Window == _lastRewrite.Context.Window)
        {
            var undo = _lastRewrite;
            _lastRewrite = null;
            _token.Clear();
            ++_revision;
            ScheduleUndo(undo);
            return 1;
        }

        ForegroundSnapshot current = ForegroundContext.Capture();
        if (!ForegroundContext.IsAllowed(current) || current.Language == InputLanguage.Other)
        {
            _token.Clear();
            _lastRewrite = null;
            _lastContext = default;
            ++_revision;
            return CallNextHookEx(_hook, code, msg, info);
        }
        if (current.Window != _lastContext.Window || current.Language != _lastContext.Language)
        {
            _token.Clear();
            _lastRewrite = null;
        }
        _lastContext = current;

        if (vk == VkShift || vk == VkControl || vk == VkMenu)
            return CallNextHookEx(_hook, code, msg, info);

        if (ctrl || alt)
        {
            _token.Clear();
            _lastRewrite = null;
            ++_revision;
            return CallNextHookEx(_hook, code, msg, info);
        }
        if (vk is >= 0x41 and <= 0x5A)
        {
            bool upper = Pressed(VkShift) != ((GetKeyState(VkCapital) & 1) != 0);
            char typed = LayoutConverter.PhysicalKeyToCharacter(vk, current.Language, upper);
            if (typed != '\0' && _token.Length < 32)
                _token.Append(typed);
            else
                _token.Clear();
            _lastRewrite = null;
            ++_revision;
        }
        else if (vk == VkBack)
        {
            if (_token.Length > 0) _token.Length--;
            _lastRewrite = null;
            ++_revision;
        }
        else if (vk == VkSpace)
        {
            string old = _token.ToString();
            _token.Clear();
            long version = ++_revision;
            var suggested = _engine.Suggest(old, current.Language);
            if (suggested is not null)
                ScheduleRewrite(current, suggested, version);
            else
                _lastRewrite = null;
        }
        else
        {
            _token.Clear();
            _lastRewrite = null;
            ++_revision;
        }
        return CallNextHookEx(_hook, code, msg, info);
    }

    private static bool Pressed(int vk) => (GetKeyState(vk) & 0x8000) != 0;

    private void ScheduleRewrite(ForegroundSnapshot source, Correction correction, long version)
    {
        var timer = new DispatcherTimer(DispatcherPriority.Background, _dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(160)
        };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (_disposed || version != _revision) return;
            var current = ForegroundContext.Capture();
            if (current.Window != source.Window || current.Language != source.Language ||
                !ForegroundContext.IsAllowed(current) || Pressed(VkControl) || Pressed(VkMenu)) return;
            try
            {
                InputSimulator.ReplaceSuffix(correction.Original.Length + 1, correction.Replacement + " ");
                _lastRewrite = new Rewrite(current, correction.Original, correction.Replacement);
                Status?.Invoke($"Исправлено: {correction.Original} → {correction.Replacement}. Ctrl+Alt+Z — отменить.");
            }
            catch (Exception ex)
            {
                Status?.Invoke("Не удалось исправить текст: " + ex.Message);
            }
        };
        timer.Start();
    }

    private void ScheduleUndo(Rewrite undo)
    {
        var timer = new DispatcherTimer(DispatcherPriority.Background, _dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(160)
        };
        int attempts = 0;
        timer.Tick += (_, _) =>
        {
            attempts++;
            if (_disposed || attempts > 12) { timer.Stop(); return; }
            if (Pressed(VkControl) || Pressed(VkMenu)) return;
            timer.Stop();
            var current = ForegroundContext.Capture();
            if (current.Window != undo.Context.Window || !ForegroundContext.IsAllowed(current)) return;
            try
            {
                InputSimulator.ReplaceSuffix(undo.Replacement.Length + 1, undo.Original + " ");
                Status?.Invoke("Последнее автоматическое исправление отменено.");
            }
            catch (Exception ex) { Status?.Invoke("Ошибка отмены: " + ex.Message); }
        };
        timer.Start();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_hook != 0) { UnhookWindowsHookEx(_hook); _hook = 0; }
        _token.Clear();
        _lastRewrite = null;
    }
}
