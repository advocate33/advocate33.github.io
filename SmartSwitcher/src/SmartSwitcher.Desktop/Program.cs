using System.Threading;
using System.Windows;

namespace SmartSwitcher.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var mutex = new Mutex(initiallyOwned: true, name: @"Local\SmartSwitcher_Proto_0_1", createdNew: out bool isFirst);
        if (!isFirst)
        {
            MessageBox.Show("SmartSwitcher уже запущен. Проверьте область уведомлений Windows.", "SmartSwitcher");
            return;
        }
        var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        application.Run(new MainWindow());
    }
}
