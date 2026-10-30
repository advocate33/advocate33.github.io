using System.Diagnostics;
using System.Runtime.InteropServices;
using SmartSwitcher.Core;

namespace SmartSwitcher.Desktop;

internal readonly record struct ForegroundSnapshot(nint Window, string ProcessName, InputLanguage Language);

internal static class ForegroundContext
{
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern nint GetKeyboardLayout(uint idThread);

    internal static ForegroundSnapshot Capture()
    {
        nint handle = GetForegroundWindow();
        if (handle == 0) return default;
        uint thread = GetWindowThreadProcessId(handle, out uint processId);
        if (processId == 0) return default;
        string processName;
        try
        {
            using var process = Process.GetProcessById(checked((int)processId));
            processName = process.ProcessName;
        }
        catch
        {
            return default;
        }
        ushort langId = unchecked((ushort)((long)GetKeyboardLayout(thread) & 0xffff));
        InputLanguage language = (langId & 0x03ff) switch
        {
            0x0019 => InputLanguage.Russian,
            0x0009 => InputLanguage.English,
            _ => InputLanguage.Other
        };
        return new ForegroundSnapshot(handle, processName, language);
    }

    internal static bool IsAllowed(ForegroundSnapshot context) =>
        context.Window != 0 && context.ProcessName.Equals("notepad", StringComparison.OrdinalIgnoreCase);
}
