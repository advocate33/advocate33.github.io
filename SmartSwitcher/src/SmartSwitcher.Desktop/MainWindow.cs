using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using SmartSwitcher.Core;
using Forms = System.Windows.Forms;

namespace SmartSwitcher.Desktop;

internal sealed class MainWindow : Window
{
    private readonly CorrectionEngine _engine = new();
    private readonly CheckBox _enableCorrection;
    private readonly TextBlock _status;
    private readonly TextBox _input;
    private readonly TextBox _output;
    private readonly Forms.NotifyIcon _tray;
    private KeyboardHook? _keyboard;

    public MainWindow()
    {
        Title = "SmartSwitcher — прототип 0.1";
        Width = 690;
        Height = 690;
        MinWidth = 580;
        MinHeight = 580;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.FromRgb(247, 249, 252));
        FontFamily = new FontFamily("Segoe UI");

        _tray = new Forms.NotifyIcon
        {
            Text = "SmartSwitcher 0.1 — автокоррекция выключена",
            Icon = System.Drawing.SystemIcons.Application,
            Visible = true
        };
        _tray.DoubleClick += (_, _) => Dispatcher.Invoke(ShowMainWindow);
        var context = new Forms.ContextMenuStrip();
        context.Items.Add("Открыть SmartSwitcher", null, (_, _) => Dispatcher.Invoke(ShowMainWindow));
        context.Items.Add("Выход", null, (_, _) => Dispatcher.Invoke(Close));
        _tray.ContextMenuStrip = context;

        var root = new StackPanel { Margin = new Thickness(25) };
        var scroll = new ScrollViewer { Content = root, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Content = scroll;

        root.Children.Add(new TextBlock
        {
            Text = "SmartSwitcher", FontSize = 27, FontWeight = FontWeights.Bold,
            Foreground = Brushes.DarkSlateBlue
        });
        root.Children.Add(Paragraph(
            "Первый прототип. Офлайн-правила, ручная коррекция текста и ограниченная автокоррекция в Блокноте.", 13));

        root.Children.Add(Heading("Автоматическое исправление"));
        _enableCorrection = new CheckBox
        {
            Content = "Включить экспериментальную автокоррекцию (только Блокнот Windows)",
            FontSize = 14,
            Margin = new Thickness(0, 5, 0, 4),
            IsChecked = false
        };
        _enableCorrection.Checked += EnableCorrection;
        _enableCorrection.Unchecked += DisableCorrection;
        root.Children.Add(_enableCorrection);
        root.Children.Add(Paragraph(
            "Исправление выполняется после пробела. В первой версии программа не перехватывает ввод в Word, браузерах и полях пароля. Ctrl+Alt+F12 — выключить обработчик, Ctrl+Alt+Z — отменить последнее исправление.", 12));
        _status = Paragraph("Состояние: выключено. Ввод с клавиатуры не отслеживается.", 13);
        _status.FontWeight = FontWeights.SemiBold;
        root.Children.Add(_status);

        root.Children.Add(Heading("Ручная проверка текста (без интернета)"));
        root.Children.Add(Paragraph("Вставьте текст, нажмите «Исправить» и проверьте результат перед копированием.", 12));
        _input = Editor("Ghbdtn! Это ПРивет. ГПК РФ. hello.");
        root.Children.Add(_input);

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 9, 0, 9) };
        var checkButton = ActionButton("Исправить текст", () =>
        {
            if (_input.Text.Length > 200_000)
            {
                MessageBox.Show(this, "Ограничение прототипа: не более 200 000 символов.");
                return;
            }
            var result = _engine.CorrectText(_input.Text);
            _output.Text = result.Text;
            _status.Text = $"Ручная обработка: {result.Count} исправлений. Исходный текст не сохранялся.";
        });
        buttons.Children.Add(checkButton);
        buttons.Children.Add(ActionButton("Скопировать результат", () =>
        {
            if (!string.IsNullOrEmpty(_output.Text))
            {
                try { Clipboard.SetText(_output.Text); }
                catch (Exception ex) { MessageBox.Show(this, "Буфер обмена недоступен: " + ex.Message); }
            }
        }));
        root.Children.Add(buttons);
        _output = Editor("");
        _output.IsReadOnly = true;
        root.Children.Add(_output);
        root.Children.Add(Paragraph(
            "Важно: автоматическая коррекция поддерживает пока только небольшой проверенный словарь. " +
            "Неизвестные слова остаются без изменений. Окна с повышенными правами и RDP не поддерживаются.", 12));
        root.Children.Add(Heading("Следующие этапы"));
        root.Children.Add(Paragraph(
            "Расширенные правила, исключения, юридический словарь, шаблоны, индикатор языка, " +
            "локальная диктовка, ChatGPT через браузер и зашифрованная синхронизация. Пока не реализованы.", 12));

        StateChanged += (_, _) =>
        {
            if (WindowState == WindowState.Minimized) Hide();
        };
        Closed += (_, _) =>
        {
            _keyboard?.Dispose();
            _tray.Visible = false;
            _tray.ContextMenuStrip?.Dispose();
            _tray.Dispose();
        };
    }

    private void EnableCorrection(object sender, RoutedEventArgs e)
    {
        var answer = MessageBox.Show(this,
            "Экспериментальная автокоррекция включается ТОЛЬКО для Блокнота Windows. " +
            "Перед использованием сохраните открытые документы. Возможны ошибки при сложном вводе. " +
            "Содержимое набора не сохраняется и не отправляется по сети. Продолжить?",
            "Подтверждение", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (answer != MessageBoxResult.Yes)
        {
            _enableCorrection.IsChecked = false;
            return;
        }
        try
        {
            _keyboard = new KeyboardHook(Dispatcher);
            _keyboard.ToggleRequested += () => _enableCorrection.IsChecked = false;
            _keyboard.Status += status => _status.Text = status;
            _status.Text = "Автокоррекция включена: только Блокнот. Ctrl+Alt+F12 — отключить.";
            _tray.Text = "SmartSwitcher 0.1 — автокоррекция включена";
        }
        catch (Exception ex)
        {
            _enableCorrection.IsChecked = false;
            MessageBox.Show(this, "Не удалось включить обработчик: " + ex.Message);
        }
    }

    private void DisableCorrection(object sender, RoutedEventArgs e)
    {
        _keyboard?.Dispose();
        _keyboard = null;
        _status.Text = "Автокоррекция выключена. Ввод с клавиатуры не отслеживается.";
        _tray.Text = "SmartSwitcher 0.1 — автокоррекция выключена";
    }

    private void ShowMainWindow()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private static TextBox Editor(string initial) => new()
    {
        Text = initial,
        FontSize = 15,
        AcceptsReturn = true,
        TextWrapping = TextWrapping.Wrap,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        Height = 110,
        Padding = new Thickness(9),
        Background = Brushes.White,
        BorderBrush = Brushes.LightGray
    };

    private static TextBlock Heading(string text) => new()
    {
        Text = text, FontSize = 17, FontWeight = FontWeights.Bold,
        Margin = new Thickness(0, 19, 0, 6)
    };

    private static TextBlock Paragraph(string text, double size) => new()
    {
        Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap,
        Foreground = Brushes.DimGray,
        Margin = new Thickness(0, 5, 0, 5)
    };

    private static Button ActionButton(string label, Action click)
    {
        var button = new Button
        {
            Content = label, Padding = new Thickness(14, 8, 14, 8),
            Margin = new Thickness(0, 0, 8, 0),
            Background = Brushes.White
        };
        button.Click += (_, _) => click();
        return button;
    }
}
