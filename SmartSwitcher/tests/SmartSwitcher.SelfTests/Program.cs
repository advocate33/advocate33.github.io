using SmartSwitcher.Core;

var engine = new CorrectionEngine();
var checks = new (string Input, InputLanguage Language, string? Expected)[]
{
    ("ghbdtn", InputLanguage.English, "привет"),
    ("Ghbdtn", InputLanguage.English, "Привет"),
    ("GHBDTN", InputLanguage.English, "ПРИВЕТ"),
    ("руддщ", InputLanguage.Russian, "hello"),
    ("РУДДЩ", InputLanguage.Russian, "HELLO"),
    ("ПРивет", InputLanguage.Russian, "Привет"),
    ("hello", InputLanguage.English, null),
    ("ГПК", InputLanguage.Russian, null),
    ("ООО", InputLanguage.Russian, null),
    ("п@роль", InputLanguage.Russian, null),
    ("x", InputLanguage.English, null),
    ("abc123", InputLanguage.English, null),
    ("ghbdtn", InputLanguage.Other, null)
};
int failed = 0;
foreach (var check in checks)
{
    var result = engine.Suggest(check.Input, check.Language)?.Replacement;
    if (result != check.Expected)
    {
        Console.Error.WriteLine($"FAILED: {check.Input} => {result ?? "NULL"}, expected {check.Expected ?? "NULL"}");
        failed++;
    }
}
var edited = engine.CorrectText("Ghbdtn! Это ПРивет, hello. ГПК РФ.");
if (edited.Text != "Привет! Это Привет, hello. ГПК РФ." || edited.Count != 2)
{
    Console.Error.WriteLine($"FAILED: CorrectText => {edited.Text}; edits={edited.Count}");
    failed++;
}
Console.WriteLine($"SmartSwitcher Core self-tests: {checks.Length + 1 - failed}/{checks.Length + 1} passed");
return failed == 0 ? 0 : 1;
