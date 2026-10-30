package ru.family.privatescan;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentSender;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;

import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int REQUEST_SCAN = 7301;
    private static final int REQUEST_IMPORT = 7302;
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";
    private static final int DARK = Color.rgb(20, 33, 47);
    private static final int TEAL = Color.rgb(0, 119, 125);
    private static final int PALE = Color.rgb(237, 246, 247);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayList<Document> documents = new ArrayList<>();
    private final OfflineOcr offlineOcr = new OfflineOcr();
    private final A4PdfFormatter a4Formatter = new A4PdfFormatter();
    private ChatGptLogin chatLogin;
    private ChatGptProcessing chatProcessing;
    private LinearLayout list;
    private TextView status;
    private EditText search;

    private static final class Document {
        final Uri uri;
        final String name;
        final long bytes;
        final long created;
        Document(Uri uri, String name, long bytes, long created) {
            this.uri = uri; this.name = name; this.bytes = bytes; this.created = created;
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        chatLogin = new ChatGptLogin(this);
        chatProcessing = new ChatGptProcessing(chatLogin);
        getWindow().setStatusBarColor(DARK);
        getWindow().setNavigationBarColor(Color.BLACK);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(PALE);
        root.setPadding(dp(18), dp(16), dp(18), dp(12));
        setContentView(root);

        TextView title = new TextView(this);
        title.setText("Частный сканер");
        title.setTextSize(26);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(DARK);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Сканирование документов в PDF без аккаунта Adobe");
        subtitle.setTextSize(13);
        subtitle.setTextColor(Color.DKGRAY);
        subtitle.setPadding(0, dp(2), 0, dp(16));
        root.addView(subtitle);

        Button add = new Button(this);
        add.setText("＋  Автосканирование страниц");
        add.setAllCaps(false);
        add.setTextColor(Color.WHITE);
        add.setBackground(round(TEAL, 14));
        add.setOnClickListener(v -> startScan());
        LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(-1, dp(56));
        root.addView(add, addParams);
        TextView captureHint = new TextView(this);
        captureHint.setText("Наведите камеру на документ и удерживайте неподвижно. "
                + "Сканер сам определяет границы и выполняет автозахват, если функция поддерживается устройством. "
                + "Каждый лист добавляется в тот же PDF. После сохранения создаётся отдельный A4.");
        captureHint.setTextSize(12);
        captureHint.setTextColor(Color.DKGRAY);
        captureHint.setPadding(0, dp(6), 0, dp(6));
        root.addView(captureHint);

        Button importBtn = new Button(this);
        importBtn.setText("＋  Импортировать готовый PDF");
        importBtn.setAllCaps(false);
        importBtn.setTextColor(TEAL);
        importBtn.setOnClickListener(v -> selectPdf());
        LinearLayout.LayoutParams importParams = new LinearLayout.LayoutParams(-1, dp(46));
        importParams.topMargin = dp(6);
        root.addView(importBtn, importParams);

        Button connectBtn = new Button(this);
        connectBtn.setText("Подключить ChatGPT без API-ключа");
        connectBtn.setAllCaps(false);
        connectBtn.setTextColor(TEAL);
        connectBtn.setOnClickListener(v -> showChatConnection());
        LinearLayout.LayoutParams chatParams = new LinearLayout.LayoutParams(-1, dp(46));
        chatParams.topMargin = dp(4);
        root.addView(connectBtn, chatParams);

        search = new EditText(this);
        search.setSingleLine(true);
        search.setTextSize(15);
        search.setHint("Поиск по имени документа");
        search.setPadding(dp(14), 0, dp(14), 0);
        search.setBackground(round(Color.WHITE, 12));
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(-1, dp(48));
        searchParams.topMargin = dp(16);
        root.addView(search, searchParams);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int st, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { render(); }
            @Override public void afterTextChanged(Editable e) {}
        });

        status = new TextView(this);
        status.setTextColor(DARK);
        status.setTextSize(14);
        status.setPadding(0, dp(16), 0, dp(8));
        root.addView(status);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        TextView notice = new TextView(this);
        notice.setText("PDF сохраняются в Документы/PrivateScan. Сканирование использует компоненты Google Play.");
        notice.setTextColor(Color.DKGRAY);
        notice.setTextSize(11);
        notice.setPadding(0, dp(10), 0, dp(4));
        root.addView(notice);
        load();
    }

    @Override protected void onResume() {
        super.onResume();
        if (list != null) load();
    }

    private void startScan() {
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
                .setGalleryImportAllowed(true)
                .setPageLimit(75)
                .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
                .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
        status.setText("Открываю автосканер: границы, фокус и захват управляются Google ML Kit…");
        scanner.getStartScanIntent(this)
                .addOnSuccessListener(sender -> {
                    try {
                        startIntentSenderForResult(sender, REQUEST_SCAN, null, 0, 0, 0);
                    } catch (IntentSender.SendIntentException e) {
                        showError("Не удалось открыть камеру: " + e.getMessage());
                    }
                })
                .addOnFailureListener(e -> showError("Сканирование недоступно: " + e.getMessage() +
                        ". Проверьте Google Play Services и подключение для первого запуска."));
    }

    @Override protected void onActivityResult(int request, int resultCode, Intent data) {
        super.onActivityResult(request, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;
        if (request == REQUEST_IMPORT) {
            if (data.getData() != null) importPdf(data.getData());
            return;
        }
        if (request != REQUEST_SCAN) return;
        GmsDocumentScanningResult result = GmsDocumentScanningResult.fromActivityResultIntent(data);
        if (result == null || result.getPdf() == null) {
            showError("Сканер не вернул PDF");
            return;
        }
        savePdf(result.getPdf().getUri());
    }

    private void savePdf(Uri original) {
        status.setText("Сохранение документа…");
        io.execute(() -> {
            Uri dest = null;
            try {
                ContentResolver resolver = getContentResolver();
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME,
                        "Скан_" + new SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT).format(new Date()) + ".pdf");
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                dest = resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv);
                if (dest == null) throw new IllegalStateException("Не удалось создать файл");
                try (InputStream in = resolver.openInputStream(original);
                     OutputStream out = resolver.openOutputStream(dest, "w")) {
                    if (in == null || out == null) throw new IllegalStateException("Поток PDF недоступен");
                    byte[] buffer = new byte[32768];
                    int n;
                    while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                }
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(dest, ready, null, null);
                Uri originalSaved = dest;
                runOnUiThread(() -> {
                    toast("Оригинал сохранён. Создаю A4…");
                    load();
                    formatA4(originalSaved, "Скан", true);
                });
            } catch (Exception e) {
                if (dest != null) try { getContentResolver().delete(dest, null, null); } catch (Exception ignored) {}
                showError("Ошибка сохранения PDF: " + e.getMessage());
            }
        });
    }

    private void load() {
        ArrayList<Document> output = new ArrayList<>();
        Uri base = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        String[] columns = { MediaStore.Files.FileColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_ADDED };
        String selection = MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " +
                MediaStore.MediaColumns.MIME_TYPE + "=?";
        try (Cursor c = getContentResolver().query(base, columns, selection,
                new String[]{FOLDER, "application/pdf"},
                MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (c != null) {
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    output.add(new Document(android.content.ContentUris.withAppendedId(base, id),
                            c.getString(1), c.getLong(2), c.getLong(3)));
                }
            }
        } catch (Exception e) {
            status.setText("Не удалось получить список: " + e.getMessage());
            return;
        }
        documents.clear();
        documents.addAll(output);
        render();
    }

    private void render() {
        if (list == null || search == null) return;
        list.removeAllViews();
        String q = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        int visible = 0;
        for (Document doc : documents) {
            if (!doc.name.toLowerCase(Locale.ROOT).contains(q)) continue;
            visible++;
            LinearLayout panel = new LinearLayout(this);
            panel.setOrientation(LinearLayout.VERTICAL);
            panel.setPadding(dp(12), dp(12), dp(12), dp(10));
            panel.setBackground(round(Color.WHITE, 14));

            TextView name = new TextView(this);
            name.setText("▤  " + doc.name);
            name.setTextColor(DARK);
            name.setTextSize(15);
            name.setTypeface(null, Typeface.BOLD);
            panel.addView(name);

            TextView meta = new TextView(this);
            String when = new SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault())
                    .format(new Date(doc.created * 1000));
            meta.setText(when + "  ·  " + Math.max(1, doc.bytes / 1024) + " КБ");
            meta.setTextColor(Color.DKGRAY);
            meta.setTextSize(12);
            meta.setPadding(0, dp(6), 0, dp(6));
            panel.addView(meta);

            LinearLayout actions = new LinearLayout(this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            actions.setGravity(Gravity.CENTER_VERTICAL);
            action(actions, "Открыть", () -> open(doc));
            action(actions, "Отправить", () -> share(doc));
            action(actions, "Имя", () -> rename(doc));
            action(actions, "Удалить", () -> confirmDelete(doc));
            panel.addView(actions);

            TextView ocrAction = new TextView(this);
            ocrAction.setText("⌕  Создать поисковый PDF · RU/EN · без интернета");
            ocrAction.setTextSize(13);
            ocrAction.setTextColor(TEAL);
            ocrAction.setPadding(dp(6), dp(13), dp(6), dp(7));
            ocrAction.setOnClickListener(v -> doOfflineOcr(doc));
            panel.addView(ocrAction);

            TextView a4Action = new TextView(this);
            a4Action.setText("▣  Подогнать страницы под формат A4");
            a4Action.setTextSize(13);
            a4Action.setTextColor(TEAL);
            a4Action.setPadding(dp(6), dp(8), dp(6), dp(8));
            a4Action.setOnClickListener(v -> formatA4(doc.uri, doc.name, false));
            panel.addView(a4Action);

            TextView chatAction = new TextView(this);
            chatAction.setText("✦  ChatGPT по подписке → текстовый PDF");
            chatAction.setTextSize(13);
            chatAction.setTextColor(TEAL);
            chatAction.setPadding(dp(6), dp(9), dp(6), dp(9));
            chatAction.setOnClickListener(v -> requestChatOcr(doc));
            panel.addView(chatAction);

            TextView aiShare = new TextView(this);
            aiShare.setText("✦  Отправить в ChatGPT / Claude / Gemini / Яндекс");
            aiShare.setTextSize(13);
            aiShare.setTextColor(TEAL);
            aiShare.setPadding(dp(6), dp(9), dp(6), dp(9));
            aiShare.setOnClickListener(v -> confirmAiShare(doc));
            panel.addView(aiShare);

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.bottomMargin = dp(10);
            list.addView(panel, lp);
        }
        status.setText(visible == 0 ? "Нет документов. Начните со сканирования." :
                "Документов: " + visible);
    }

    private void action(LinearLayout row, String title, Runnable callback) {
        TextView b = new TextView(this);
        b.setText(title);
        b.setTextSize(12);
        b.setTextColor(TEAL);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(4), dp(11), dp(4), dp(11));
        b.setOnClickListener(v -> callback.run());
        row.addView(b, new LinearLayout.LayoutParams(0, -2, 1));
    }

    private void open(Document doc) {
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(doc.uri, "application/pdf");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivity(i); }
        catch (Exception e) { showError("Установите приложение для просмотра PDF"); }
    }

    private void share(Document doc) {
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("application/pdf");
        i.putExtra(Intent.EXTRA_STREAM, doc.uri);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(i, "Отправить PDF"));
    }

    private void rename(Document doc) {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setText(doc.name.endsWith(".pdf") ? doc.name.substring(0, doc.name.length() - 4) : doc.name);
        new AlertDialog.Builder(this)
                .setTitle("Переименовать PDF")
                .setView(field)
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Сохранить", (dialog, which) -> {
                    String name = field.getText().toString().trim().replaceAll("[/\\\\:*?\"<>|]", "_");
                    if (name.isEmpty()) { toast("Имя пустое"); return; }
                    try {
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name + ".pdf");
                        if (getContentResolver().update(doc.uri, cv, null, null) < 1) {
                            toast("Не удалось переименовать"); return;
                        }
                        load();
                    } catch (Exception e) { showError("Ошибка переименования: " + e.getMessage()); }
                }).show();
    }

    private void confirmDelete(Document doc) {
        new AlertDialog.Builder(this).setTitle("Удалить документ?")
                .setMessage(doc.name + "\nЭто действие нельзя отменить.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Удалить", (dialog, which) -> {
                    try { getContentResolver().delete(doc.uri, null, null); load(); }
                    catch (Exception e) { showError("Ошибка удаления: " + e.getMessage()); }
                }).show();
    }




    private void showChatConnection() {
        String message = chatLogin.connected()
                ? "Подключён: " + chatLogin.accountLabel()
                    + ". Запросы будут расходовать лимит ChatGPT-подписки."
                : "Откроется официальный сайт OpenAI для входа. "
                    + "Вы разрешите PrivateScan использовать лимит подписки ChatGPT. "
                    + "Пароль и API-ключ в PrivateScan вводить не нужно.";
        new AlertDialog.Builder(this)
                .setTitle("ChatGPT: подключение по подписке")
                .setMessage(message)
                .setNegativeButton("Закрыть", null)
                .setNeutralButton(chatLogin.connected() ? "Отключить" : "Сведения",
                    (d, w) -> {
                        if (chatLogin.connected()) {
                            status.setText("Отключение ChatGPT…");
                            chatLogin.signOut(this, new ChatGptLogin.Callback() {
                                @Override public void onSuccess(String info) { status.setText(info); toast(info); }
                                @Override public void onError(String reason) { showError(reason); }
                            });
                        } else {
                            new AlertDialog.Builder(this)
                                .setTitle("Правила работы")
                                .setMessage("Без API-ключа доступен только официальный вход "
                                    + "через браузер и разрешение использования подписки. "
                                    + "PrivateScan не получает историю чатов. "
                                    + "Загрузки документов осуществляются только после вашего подтверждения.")
                                .setPositiveButton("ОК", null).show();
                        }
                    })
                .setPositiveButton("Продолжить с ChatGPT", (d, w) -> {
                    status.setText("Ожидание авторизации ChatGPT в браузере…");
                    chatLogin.login(this, new ChatGptLogin.Callback() {
                        @Override public void onProgress(String info) {
                            status.setText(info);
                        }
                        @Override public void onSuccess(String info) {
                            status.setText("ChatGPT подключён: " + info);
                            toast("Аккаунт ChatGPT подключён");
                        }
                        @Override public void onError(String reason) {
                            showError("Ошибка входа ChatGPT: " + reason);
                        }
                    });
                })
                .show();
    }

    private void requestChatOcr(Document doc) {
        if (!chatLogin.connected()) {
            showChatConnection();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("Отправить документ в ChatGPT?")
            .setMessage("PDF «" + doc.name
                + "» будет передан OpenAI через официальный Responses API с доступом по вашей подписке. "
                + "Это расходует лимиты подписки. Будет создан отдельный текстовый PDF; "
                + "изображение оригинала не меняется. "
                + "ИИ может ошибаться в реквизитах. Передавать конфиденциальные материалы без "
                + "отдельной оценки условий сервиса не следует.")
            .setNegativeButton("Отмена", null)
            .setPositiveButton("Разрешить отправку", (dialog, which) -> {
                status.setText("Отправка PDF в ChatGPT…");
                chatProcessing.process(this, doc.uri, doc.name, new ChatGptProcessing.Listener() {
                    @Override public void onSuccess(Uri pdf, String model) {
                        load();
                        new AlertDialog.Builder(MainActivity.this)
                            .setTitle("Распознанная копия создана")
                            .setMessage("Модель: " + model + ". "
                                + "Создан отдельный текстовый PDF. "
                                + "Оригинал сохранён. Сверьте реквизиты с исходным сканом.")
                            .setNegativeButton("Закрыть", null)
                            .setPositiveButton("Открыть", (d, w) ->
                                open(new Document(pdf, "ChatGPT PDF", 0,
                                    System.currentTimeMillis() / 1000)))
                            .show();
                    }
                    @Override public void onError(String reason) {
                        showError("ChatGPT: " + reason);
                    }
                });
            }).show();
    }


    private void formatA4(Uri pdf, String name, boolean automatic) {
        status.setText("Подгонка страниц под A4…");
        a4Formatter.format(this, pdf, name, new A4PdfFormatter.Listener() {
            @Override public void onProgress(int current, int total) {
                status.setText("Форматирование A4: страница " + current + " из " + total);
            }
            @Override public void onSuccess(Uri saved, int pages) {
                load();
                status.setText("Готово: " + pages + " стр. А4. Оригинал сохранён отдельно.");
                if (!automatic) {
                    new AlertDialog.Builder(MainActivity.this)
                        .setTitle("PDF формата A4 готов")
                        .setMessage("Все страницы подогнаны без обрезания содержимого. "
                                + "Создан отдельный PDF. Читаемость зависит от качества исходного снимка.")
                        .setNegativeButton("Закрыть", null)
                        .setPositiveButton("Открыть", (dialog, which) ->
                            open(new Document(saved, "A4", 0, System.currentTimeMillis()/1000)))
                        .show();
                }
            }
            @Override public void onError(String error) {
                showError("Оригинал сохранён, но создать A4 не удалось: " + error);
            }
        });
    }

    private void selectPdf() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        try { startActivityForResult(intent, REQUEST_IMPORT); }
        catch (Exception error) { showError("Не удалось открыть выбор файла: " + error.getMessage()); }
    }

    private void importPdf(Uri uri) {
        io.execute(() -> {
            Uri dest = null;
            try {
                String name = "Импорт_" + System.currentTimeMillis() + ".pdf";
                try (Cursor c = getContentResolver().query(uri,
                        new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        String incoming = c.getString(0);
                        if (incoming != null && incoming.toLowerCase(Locale.ROOT).endsWith(".pdf"))
                            name = incoming.replaceAll("[/\\\\:*?\"<>|]", "_");
                    }
                } catch (Exception ignored) { }
                ContentResolver resolver = getContentResolver();
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME,
                        "Импорт_" + System.currentTimeMillis() + "_" + name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                dest = resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv);
                if (dest == null) throw new IllegalStateException("Не удалось создать файл");
                try (InputStream in = resolver.openInputStream(uri);
                     OutputStream out = resolver.openOutputStream(dest, "w")) {
                    if (in == null || out == null) throw new IllegalStateException("Файл недоступен");
                    byte[] buffer = new byte[32768];
                    int bytes;
                    long total = 0;
                    while ((bytes = in.read(buffer)) != -1) {
                        total += bytes;
                        if (total > 60L * 1024 * 1024)
                            throw new IllegalArgumentException("Максимальный размер PDF 60 МБ");
                        out.write(buffer, 0, bytes);
                    }
                }
                ContentValues cv2 = new ContentValues();
                cv2.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(dest, cv2, null, null);
                runOnUiThread(() -> { load(); toast("PDF импортирован"); });
            } catch (Exception error) {
                if (dest != null) try { getContentResolver().delete(dest, null, null); }
                catch (Exception ignored) {}
                showError("Ошибка импорта: " + error.getMessage());
            }
        });
    }

    private void doOfflineOcr(Document doc) {
        new AlertDialog.Builder(this)
                .setTitle("Создать поисковый PDF?")
                .setMessage("Распознавание русского и английского текста выполнится на этом устройстве. "
                        + "Оригинальное изображение страниц сохранится, поверх добавится невидимый текст. "
                        + "Интернет и подписка не нужны. Оригинал останется отдельно.")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Распознать", (dialog, which) -> {
                    status.setText("Запуск локального OCR…");
                    offlineOcr.run(this, doc.uri, doc.name, new OfflineOcr.Listener() {
                        @Override public void onProgress(int n, int total) {
                            status.setText("Локальное OCR: страница " + n + " из " + total);
                        }
                        @Override public void onSuccess(Uri pdf, int count) {
                            load();
                            new AlertDialog.Builder(MainActivity.this)
                                    .setTitle("Поисковый PDF готов")
                                    .setMessage("Найдено слов: " + count + ". "
                                        + "Оригинал сохранён. Сверьте даты, суммы, номера дел и имена.")
                                    .setNegativeButton("Закрыть", null)
                                    .setPositiveButton("Открыть", (d, w) ->
                                        open(new Document(pdf, "Поисковый PDF", 0,
                                            System.currentTimeMillis() / 1000)))
                                    .show();
                        }
                        @Override public void onError(String reason) {
                            showError("Ошибка локального OCR: " + reason);
                        }
                    });
                }).show();
    }

    private void confirmAiShare(Document doc) {
        new AlertDialog.Builder(this)
                .setTitle("Передать файл нейросети?")
                .setMessage("Выберите установленное приложение (ChatGPT, Claude, Gemini, Алиса и др.). "
                        + "PDF покинет PrivateScan и будет обработан выбранным сервисом. "
                        + "Не отправляйте материалы адвокатской тайны без оценки условий передачи. "
                        + "Готовый PDF затем импортируйте кнопкой «Импортировать готовый PDF».")
                .setNegativeButton("Отмена", null)
                .setPositiveButton("Выбрать приложение", (dialog, which) -> {
                    try {
                        Intent i = new Intent(Intent.ACTION_SEND);
                        i.setType("application/pdf");
                        i.putExtra(Intent.EXTRA_STREAM, doc.uri);
                        i.putExtra(Intent.EXTRA_TEXT,
                            "Распознай документ точно, сохрани исходные реквизиты, "
                          + "таблицы и структуру. Не придумывай нечитаемые фрагменты. "
                          + "При возможности создай поисковый PDF.");
                        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(i, "Передать PDF в нейросеть"));
                    } catch (Exception ex) {
                        showError("Нет приложения, принимающего PDF: " + ex.getMessage());
                    }
                }).show();
    }

    private GradientDrawable round(int color, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radiusDp));
        return d;
    }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    private void showError(String message) { runOnUiThread(() -> {
        if (status != null) status.setText(message);
        toast(message);
    }); }
    @Override protected void onDestroy() {
        super.onDestroy();
        io.shutdown();
        offlineOcr.shutdown();
        a4Formatter.shutdown();
        chatProcessing.shutdown();
        chatLogin.shutdown();
    }
}
