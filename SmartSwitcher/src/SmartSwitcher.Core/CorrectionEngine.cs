using System.Text.RegularExpressions;

namespace SmartSwitcher.Core;

public record Correction(string Original, string Replacement, string Rule);

/// <summary>
/// Conservative offline correction: replace only words from an explicit whitelist.
/// Never stores text or guesses unfamiliar words.
/// </summary>
public sealed class CorrectionEngine
{
    private static readonly HashSet<string> RussianWords = new(StringComparer.Ordinal)
    {
        "привет", "пока", "спасибо", "пожалуйста", "добрый", "день", "вечер", "утро",
        "сегодня", "завтра", "вчера", "работа", "документ", "документы", "текст",
        "слово", "слова", "проверка", "исправление", "заявление", "суд", "адвокат",
        "дело", "клиент", "договор", "статья", "закона", "закон", "решение",
        "встреча", "письмо", "здравствуйте", "можно", "нужно", "хорошо",
        "когда", "почему", "как", "что", "это", "для", "нет", "да",
        "мой", "твой", "наш", "ваш", "дом", "город", "время"
    };

    private static readonly HashSet<string> EnglishWords = new(StringComparer.Ordinal)
    {
        "hello", "world", "test", "thank", "thanks", "please", "good", "morning",
        "night", "today", "tomorrow", "yesterday", "computer", "keyboard", "text",
        "word", "words", "work", "document", "documents", "switch", "language",
        "english", "russian", "message", "email", "yes", "no", "you", "your",
        "our", "home", "office", "time", "day", "phone", "number", "file",
        "save", "open", "close", "windows", "login", "account", "project"
    };

    private static readonly Regex WordPattern = new(@"[A-Za-zА-Яа-яЁё]+", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public Correction? Suggest(string word, InputLanguage typedLayout)
    {
        if (word.Length is < 3 or > 32 || !word.All(char.IsLetter)) return null;
        if (typedLayout is not (InputLanguage.English or InputLanguage.Russian)) return null;
        if (word.Any(c => typedLayout == InputLanguage.English ? !IsLatin(c) : !IsCyrillic(c))) return null;

        var lower = word.ToLowerInvariant();
        string candidate = LayoutConverter.Convert(lower, typedLayout);
        bool accepted = typedLayout == InputLanguage.English
            ? RussianWords.Contains(candidate)
            : EnglishWords.Contains(candidate);
        if (accepted)
        {
            var restored = RestoreCase(word, candidate);
            if (!string.Equals(word, restored, StringComparison.Ordinal))
                return new Correction(word, restored, "Раскладка");
        }
        if (word.Length >= 3 && char.IsUpper(word[0]) && char.IsUpper(word[1])
            && word.Skip(2).All(char.IsLower))
        {
            string fixedCase = word[0] + word[1..].ToLowerInvariant();
            return new Correction(word, fixedCase, "Две заглавные");
        }
        return null;
    }

    public (string Text, int Count) CorrectText(string text)
    {
        int count = 0;
        string output = WordPattern.Replace(text, m =>
        {
            bool latin = m.Value.All(IsLatin);
            bool cyrillic = m.Value.All(IsCyrillic);
            var lang = latin ? InputLanguage.English : cyrillic ? InputLanguage.Russian : InputLanguage.Other;
            Correction? change = Suggest(m.Value, lang);
            if (change is null) return m.Value;
            count++;
            return change.Replacement;
        });
        return (output, count);
    }

    private static bool IsLatin(char c) => c is >= 'A' and <= 'Z' or >= 'a' and <= 'z';
    private static bool IsCyrillic(char c) => c is >= 'А' and <= 'я' or 'Ё' or 'ё';

    private static string RestoreCase(string original, string lower)
    {
        if (original.All(char.IsUpper)) return lower.ToUpperInvariant();
        if (char.IsUpper(original[0]) && original.Skip(1).All(char.IsLower))
            return char.ToUpperInvariant(lower[0]) + lower[1..];
        return lower;
    }
}
