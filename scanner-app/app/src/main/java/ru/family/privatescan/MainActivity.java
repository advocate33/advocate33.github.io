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
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";
    private static final int DARK = Color.rgb(20, 33, 47);
    private static final int TEAL = Color.rgb(0, 119, 125);
    private static final int PALE = Color.rgb(237, 246, 247);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayList<Document> documents = new ArrayList<>();
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
        add.setText("＋  Сканировать / импортировать");
        add.setAllCaps(false);
        add.setTextColor(Color.WHITE);
        add.setBackground(round(TEAL, 14));
        add.setOnClickListener(v -> startScan());
        LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(-1, dp(56));
        root.addView(add, addParams);

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
                .setPageLimit(100)
                .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
                .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
                .build();
        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
        status.setText("Запуск сканера…");
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
        if (request != REQUEST_SCAN || resultCode != RESULT_OK || data == null) return;
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
                runOnUiThread(() -> { toast("PDF сохранён"); load(); });
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
    @Override protected void onDestroy() { super.onDestroy(); io.shutdown(); }
}
