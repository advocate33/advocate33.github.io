namespace SmartSwitcher.Core;

public enum InputLanguage { Other, English, Russian }

/// <summary>QWERTY physical key positions and standard Windows Russian layout.</summary>
public static class LayoutConverter
{
    private const string LatinKeys = "qwertyuiopasdfghjklzxcvbnm";
    private const string RussianKeys = "йцукенгшщзфывапролдячсмить";

    public static string Convert(string text, InputLanguage source)
    {
        if (source is not (InputLanguage.English or InputLanguage.Russian))
            return text;
        string from = source == InputLanguage.English ? LatinKeys : RussianKeys;
        string to = source == InputLanguage.English ? RussianKeys : LatinKeys;
        var chars = new char[text.Length];
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            int index = from.IndexOf(char.ToLowerInvariant(ch));
            chars[i] = index < 0 ? ch : char.IsUpper(ch) ? char.ToUpperInvariant(to[index]) : to[index];
        }
        return new string(chars);
    }

    public static char PhysicalKeyToCharacter(int virtualKey, InputLanguage layout, bool uppercase)
    {
        if (virtualKey < 0x41 || virtualKey > 0x5A)
            return '\0';
        char letter = (char)(virtualKey + 32); // A..Z => a..z
        if (layout == InputLanguage.Russian)
        {
            int index = LatinKeys.IndexOf(letter);
            if (index < 0) return '\0';
            letter = RussianKeys[index];
        }
        else if (layout != InputLanguage.English)
            return '\0';
        return uppercase ? char.ToUpperInvariant(letter) : letter;
    }
}
