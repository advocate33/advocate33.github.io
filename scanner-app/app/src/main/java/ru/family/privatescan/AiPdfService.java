package ru.family.privatescan;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class AiPdfService {
    public interface Listener {
        void onSuccess(Uri result);
        void onError(String message);
    }

    private static final String PREF = "ai_preferences_v1";
    private static final String KEY_ALIAS = "PrivateScanAiKey";
    private static final String MODEL = "gpt-6.1-terra";
    private static final int MAX_FILE_BYTES = 10 * 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";
    private static final String PROMPT =
            "Точно транскрибируй ВСЕ видимые страницы приложенного PDF на языке оригинала. "
            + "Не пересказывай и не добавляй ничего от себя. "
            + "Строго сохраняй все ФИО, номера дел, суммы, даты, адреса, названия и знаки препинания. "
            + "Не исправляй исходный юридический текст и не пытайся угадать нечитаемые слова: "
            + "ставь [НЕРАЗБОРЧИВО]. Сохраняй абзацы, списки и возможные таблицы в текстовом виде. "
            + "Разделяй страницы строго отдельной строкой [PAGE_BREAK]. "
            + "Выведи только распознанный текст, без вступлений, пояснений и Markdown-ограждений.";

    private final Context context;
    private final SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    public AiPdfService(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public boolean hasKey() { return prefs.contains("token"); }
    public boolean autoEnabled() { return prefs.getBoolean("auto", false) && hasKey(); }
    public void setAuto(boolean enabled) { prefs.edit().putBoolean("auto", enabled).apply(); }

    public void saveKey(String value) throws Exception {
        String trimmed = value.trim();
        if (!trimmed.startsWith("sk-") || trimmed.length() < 15)
            throw new IllegalArgumentException("Ожидается персональный OpenAI API-ключ (sk-...)");
        SecretKey key = getOrCreateKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] data = cipher.doFinal(trimmed.getBytes(StandardCharsets.UTF_8));
        prefs.edit()
                .putString("token", Base64.encodeToString(data, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .apply();
    }

    public void clearKey() {
        prefs.edit().remove("token").remove("iv").putBoolean("auto", false).apply();
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS))
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build());
        return generator.generateKey();
    }

    private String readKey() throws Exception {
        String token = prefs.getString("token", null);
        String iv = prefs.getString("iv", null);
        if (token == null || iv == null) throw new IllegalStateException("API-ключ не установлен");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(token, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    public void process(Activity activity, Uri sourcePdf, String sourceName, Listener listener) {
        worker.execute(() -> {
            try {
                byte[] pdf = readBounded(context.getContentResolver().openInputStream(sourcePdf),
                        MAX_FILE_BYTES);
                if (pdf.length < 5 || pdf[0] != '%' || pdf[1] != 'P' || pdf[2] != 'D' || pdf[3] != 'F')
                    throw new IllegalArgumentException("Источник не является PDF");
                String recognized = request(readKey(), pdf);
                if (recognized.trim().length() < 6)
                    throw new IllegalStateException("ИИ не вернул пригодный текст");
                Uri result = createTextPdf(recognized, sourceName);
                activity.runOnUiThread(() -> listener.onSuccess(result));
            } catch (Exception error) {
                String message = error.getMessage() == null ? "Неизвестная ошибка" : error.getMessage();
                activity.runOnUiThread(() -> listener.onError(message));
            }
        });
    }

    private static byte[] readBounded(InputStream in, int limit) throws Exception {
        if (in == null) throw new IllegalStateException("Файл не открывается");
        try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = source.read(buffer)) != -1) {
                if (out.size() + count > limit)
                    throw new IllegalArgumentException("Файл слишком большой для ИИ (максимум 10 МБ)");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private String request(String token, byte[] bytes) throws Exception {
        JSONObject file = new JSONObject();
        file.put("type", "input_file");
        file.put("filename", "scan.pdf");
        file.put("detail", "high");
        file.put("file_data", "data:application/pdf;base64,"
                + Base64.encodeToString(bytes, Base64.NO_WRAP));

        JSONObject instruction = new JSONObject();
        instruction.put("type", "input_text");
        instruction.put("text", PROMPT);

        JSONArray content = new JSONArray();
        content.put(file);
        content.put(instruction);
        JSONObject user = new JSONObject();
        user.put("role", "user");
        user.put("content", content);

        JSONObject body = new JSONObject();
        body.put("model", MODEL);
        body.put("store", false);
        body.put("max_output_tokens", 22000);
        body.put("reasoning", new JSONObject().put("effort", "none"));
        body.put("input", new JSONArray().put(user));

        HttpURLConnection conn = (HttpURLConnection) new URL("https://api.openai.com/v1/responses")
                .openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(180000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            try (OutputStream stream = conn.getOutputStream()) {
                stream.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }

            int status = conn.getResponseCode();
            if (status == 401) throw new IllegalStateException("Неверный либо отозванный OpenAI API-ключ (401)");
            if (status == 403) throw new IllegalStateException("API недоступен для аккаунта или региона (403)");
            if (status == 429) throw new IllegalStateException("Лимит OpenAI API либо недостаточно средств (429)");
            if (status < 200 || status >= 300)
                throw new IllegalStateException("Ошибка OpenAI API: HTTP " + status);
            JSONObject response = new JSONObject(new String(
                    readBounded(conn.getInputStream(), MAX_RESPONSE_BYTES), StandardCharsets.UTF_8));
            if (!"completed".equals(response.optString("status")))
                throw new IllegalStateException("Ответ ИИ не завершён, PDF не создан. Проверьте лимиты токенов.");

            JSONArray output = response.optJSONArray("output");
            if (output == null) throw new IllegalStateException("Нет ответа от ИИ");
            StringBuilder result = new StringBuilder();
            for (int i = 0; i < output.length(); i++) {
                JSONObject item = output.optJSONObject(i);
                if (item == null || !"message".equals(item.optString("type"))) continue;
                JSONArray pieces = item.optJSONArray("content");
                if (pieces == null) continue;
                for (int j = 0; j < pieces.length(); j++) {
                    JSONObject piece = pieces.optJSONObject(j);
                    if (piece != null && "output_text".equals(piece.optString("type"))) {
                        if (result.length() > 0) result.append('\n');
                        result.append(piece.optString("text", ""));
                    }
                }
            }
            return result.toString();
        } finally {
            conn.disconnect();
        }
    }

    private Uri createTextPdf(String raw, String original) throws Exception {
        ContentValues values = new ContentValues();
        String base = original.replaceAll("(?i)\\.pdf$", "").replaceAll("[/\\\\:*?\"<>|]", "_");
        if (base.endsWith("_OCR")) base = base.substring(0, base.length() - 4);
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, base + "_OCR_" + System.currentTimeMillis() + ".pdf");
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        ContentResolver resolver = context.getContentResolver();
        Uri dest = resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
        if (dest == null) throw new IllegalStateException("Не удалось создать PDF");
        try {
            PdfDocument pdf = new PdfDocument();
            try {
                PdfWriter writer = new PdfWriter(pdf);
                String[] paragraphs = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n", -1);
                for (String paragraph : paragraphs) {
                    if ("[PAGE_BREAK]".equals(paragraph.trim())) {
                        writer.nextPage();
                        continue;
                    }
                    writer.paragraph(paragraph);
                }
                writer.finish();
                try (OutputStream out = resolver.openOutputStream(dest, "w")) {
                    if (out == null) throw new IllegalStateException("Нельзя записать PDF");
                    pdf.writeTo(out);
                }
            } finally {
                pdf.close();
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(dest, ready, null, null);
            return dest;
        } catch (Exception error) {
            try { resolver.delete(dest, null, null); } catch (Exception ignored) {}
            throw error;
        }
    }

    private static final class PdfWriter {
        private static final int W = 595;
        private static final int H = 842;
        private static final int MARGIN = 46;
        private final PdfDocument doc;
        private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint smallPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private PdfDocument.Page page;
        private Canvas canvas;
        private int pageNumber = 0;
        private float baseline;

        PdfWriter(PdfDocument doc) {
            this.doc = doc;
            textPaint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
            textPaint.setColor(Color.rgb(19, 27, 39));
            textPaint.setTextSize(11.5f);
            smallPaint.setColor(Color.GRAY);
            smallPaint.setTextSize(8.2f);
            nextPage();
        }

        void nextPage() {
            if (page != null) {
                canvas.drawText("Распознанная копия • сверяйте с оригиналом   ·   " + pageNumber,
                        MARGIN, H - 25, smallPaint);
                doc.finishPage(page);
            }
            pageNumber++;
            page = doc.startPage(new PdfDocument.PageInfo.Builder(W, H, pageNumber).create());
            canvas = page.getCanvas();
            canvas.drawColor(Color.WHITE);
            canvas.drawText("PrivateScan · OCR-копия (не заменяет оригинал)", MARGIN, 27, smallPaint);
            baseline = MARGIN + 10;
        }

        void paragraph(String paragraph) {
            if (paragraph.length() == 0) {
                line("");
                return;
            }
            String remaining = paragraph;
            int width = W - MARGIN * 2;
            while (!remaining.isEmpty()) {
                int count = textPaint.breakText(remaining, true, width, null);
                if (count <= 0) { line(""); break; }
                if (count < remaining.length()) {
                    int space = remaining.lastIndexOf(' ', count - 1);
                    if (space > 0) count = space + 1;
                }
                String chunk = remaining.substring(0, count).trim();
                line(chunk);
                remaining = remaining.substring(count).trim();
            }
        }

        private void line(String line) {
            if (baseline + 20 > H - MARGIN) nextPage();
            if (!line.isEmpty()) canvas.drawText(line, MARGIN, baseline, textPaint);
            baseline += 16.3f;
        }

        void finish() {
            if (page != null) {
                canvas.drawText("Распознанная копия • сверяйте с оригиналом   ·   " + pageNumber,
                        MARGIN, H - 25, smallPaint);
                doc.finishPage(page);
                page = null;
            }
        }
    }

    public void close() { worker.shutdown(); }
}
