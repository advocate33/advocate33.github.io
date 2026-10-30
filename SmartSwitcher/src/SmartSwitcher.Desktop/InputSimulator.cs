using System.ComponentModel;
using System.Runtime.InteropServices;

namespace SmartSwitcher.Desktop;

/// <summary>Edits are only called after foreground context revalidation.</summary>
internal static class InputSimulator
{
    private const uint InputKeyboard = 1;
    private const uint KeyUp = 0x0002;
    private const uint Unicode = 0x0004;
    private const ushort Backspace = 0x08;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public nuint dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint cInputs, INPUT[] pInputs, int cbSize);

    public static void ReplaceSuffix(int charactersToRemove, string replacement)
    {
        if (charactersToRemove < 0 || charactersToRemove > 128 || replacement.Length > 128)
            throw new ArgumentOutOfRangeException(nameof(charactersToRemove));
        var batch = new List<INPUT>((charactersToRemove + replacement.Length) * 2);
        for (int i = 0; i < charactersToRemove; i++)
        {
            batch.Add(CreateVirtualKey(Backspace, false));
            batch.Add(CreateVirtualKey(Backspace, true));
        }
        foreach (char c in replacement)
        {
            batch.Add(CreateUnicode(c, false));
            batch.Add(CreateUnicode(c, true));
        }
        INPUT[] events = batch.ToArray();
        uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf<INPUT>());
        if (sent != events.Length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not accept all simulated input.");
    }

    private static INPUT CreateVirtualKey(ushort vk, bool up) =>
        new() { type = InputKeyboard, ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KeyUp : 0 } };

    private static INPUT CreateUnicode(char ch, bool up) =>
        new() { type = InputKeyboard, ki = new KEYBDINPUT { wScan = ch, dwFlags = Unicode | (up ? KeyUp : 0) } };
}
