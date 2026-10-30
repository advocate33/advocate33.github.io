package ru.family.privatescan;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle;
import com.tom_roush.pdfbox.pdmodel.font.PDType0Font;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import android.util.Base64;

/** Explicit user-triggered cloud transcription with a verified SIWC OAuth access token.
 * Creates a separate text-only copy; the original scanned PDF is never overwritten.
 */
public final class ChatGptProcessing {
    public interface Listener {
        void onSuccess(Uri uri, String model);
        void onError(String reason);
    }
    private static final int MAX_BYTES = 12 * 1024 * 1024;
    private static final int MAX_TEXT = 180_000;
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";
    private static final String PROMPT =
            "Дословно перепиши содержание каждой страницы вложенного PDF на русском либо исходном языке. "
            + "Не добавляй пояснения, не пересказывай. Сохраняй ФИО, реквизиты, даты, суммы, номера дел, "
            + "пунктуацию и абзацы. Если текст нечитаем, пиши [НЕРАЗБОРЧИВО]. "
            + "Между исходными страницами вставляй отдельно строку [PAGE_BREAK]. "
            + "Таблицы передавай в виде выровненных строк. "
            + "Ответ только распознанный текст; не делай юридических выводов.";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ChatGptLogin login;

    public ChatGptProcessing(ChatGptLogin login) { this.login = login; }

    public void process(Activity activity, Uri source, String name, Listener result) {
        worker.execute(() -> {
            try {
                String token = login.getTokenForRequest();
                String model = chooseModel(token);
                byte[] pdf = readBounded(activity.getContentResolver().openInputStream(source), MAX_BYTES);
                if (pdf.length < 4 || pdf[0] != '%' || pdf[1] != 'P' || pdf[2] != 'D' || pdf[3] != 'F')
                    throw new IllegalArgumentException("Неверный PDF");
                String text = recognize(token, model, pdf);
                if (text.trim().isEmpty()) throw new IllegalStateException("ИИ не вернул текст");
                Uri output = saveTextPdf(activity, name, text);
                activity.runOnUiThread(() -> result.onSuccess(output, model));
            } catch (Exception e) {
                String reason = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                activity.runOnUiThread(() -> result.onError(reason));
            }
        });
    }

    private static String chooseModel(String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("https://api.openai.com/v1/models")
                .openConnection();
        c.setConnectTimeout(20_000); c.setReadTimeout(25_000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (c.getResponseCode() != 200)
                throw new IllegalStateException("Не удалось получить список моделей ChatGPT (HTTP "
                        + c.getResponseCode() + ")");
            JSONObject list = new JSONObject(new String(readBounded(c.getInputStream(), 600_000),
                    StandardCharsets.UTF_8));
            JSONArray models = list.optJSONArray("models");
            if (models == null) throw new IllegalStateException("Список моделей отсутствует");
            ArrayList<String> visible = new ArrayList<>();
            for (int i = 0; i < models.length(); i++) {
                JSONObject item = models.optJSONObject(i);
                if (item == null) continue;
                if (!"list".equals(item.optString("visibility"))) continue;
                String slug = item.optString("slug");
                if (slug.startsWith("gpt-") || slug.startsWith("o")) visible.add(slug);
            }
            if (visible.isEmpty()) throw new IllegalStateException("Нет доступных моделей ChatGPT");
            for (String preferred : new String[]{"gpt-6.1-sol","gpt-6","gpt-5.6","gpt-5.5"}) {
                if (visible.contains(preferred)) return preferred;
            }
            return visible.get(0);
        } finally { c.disconnect(); }
    }

    private static String recognize(String token, String model, byte[] pdf) throws Exception {
        JSONObject document = new JSONObject();
        document.put("type", "input_file");
        document.put("filename", "scan.pdf");
        document.put("file_data", "data:application/pdf;base64,"
                + Base64.encodeToString(pdf, Base64.NO_WRAP));
        JSONObject instruction = new JSONObject();
        instruction.put("type", "input_text");
        instruction.put("text", PROMPT);
        JSONObject message = new JSONObject();
        message.put("role", "user");
        message.put("content", new JSONArray().put(document).put(instruction));
        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("input", new JSONArray().put(message));
        body.put("store", false);
        body.put("stream", true);
        body.put("max_output_tokens", 22000);

        HttpURLConnection conn = (HttpURLConnection) new URL("https://api.openai.com/v1/responses")
                .openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(25_000); conn.setReadTimeout(180_000);
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "text/event-stream");
        try {
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int http = conn.getResponseCode();
            if (http == 401) throw new IllegalStateException("Авторизация ChatGPT недействительна");
            if (http == 403) throw new IllegalStateException("Подписка не разрешает обработку PDF");
            if (http == 429) throw new IllegalStateException("Достигнут лимит использования подписки");
            if (http < 200 || http >= 300)
                throw new IllegalStateException("Запрос ChatGPT отклонён: HTTP " + http);
            StringBuilder answer = new StringBuilder();
            boolean completed = false;
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.startsWith("data: ")) continue;
                    String data = line.substring(6).trim();
                    if ("[DONE]".equals(data) || data.isEmpty()) continue;
                    JSONObject event;
                    try { event = new JSONObject(data); } catch (Exception ignored) { continue; }
                    String type = event.optString("type");
                    if ("response.output_text.delta".equals(type)) {
                        answer.append(event.optString("delta", ""));
                        if (answer.length() > MAX_TEXT)
                            throw new IllegalStateException("Текст слишком длинный для одного PDF");
                    } else if ("response.failed".equals(type)) {
                        throw new IllegalStateException("Ошибка ответа ChatGPT или лимита подписки");
                    } else if ("response.incomplete".equals(type)) {
                        throw new IllegalStateException("Ответ не завершён: сократите документ");
                    } else if ("response.completed".equals(type)) {
                        completed = true;
                    }
                }
            }
            if (!completed) throw new IllegalStateException("Подключение прервано до завершения ответа");
            return answer.toString();
        } finally { conn.disconnect(); }
    }

    private static Uri saveTextPdf(Activity activity, String original, String text) throws Exception {
        PDFBoxResourceLoader.init(activity.getApplicationContext());
        PDDocument doc = new PDDocument();
        Uri created = null;
        try {
            PDType0Font font;
            try (InputStream in = activity.getAssets().open("fonts/NotoSans-Regular.ttf")) {
                font = PDType0Font.load(doc, in, true);
            }
            PageWriter writer = new PageWriter(doc, font);
            for (String paragraph : text.replace("\r\n", "\n").replace("\r", "\n").split("\n", -1)) {
                if ("[PAGE_BREAK]".equals(paragraph.trim())) writer.nextPage();
                else writer.paragraph(paragraph);
            }
            writer.close();

            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            String base = original.replaceAll("(?i)\\.pdf$", "")
                    .replaceAll("[/\\\\:*?\"<>|]", "_");
            values.put(MediaStore.MediaColumns.DISPLAY_NAME,
                base + "_CHATGPT_TEXT_" + System.currentTimeMillis() + ".pdf");
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            created = resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
            if (created == null) throw new IllegalStateException("Невозможно создать файл PDF");
            try (OutputStream out = resolver.openOutputStream(created, "w")) {
                if (out == null) throw new IllegalStateException("Нельзя записать PDF");
                doc.save(out);
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(created, ready, null, null);
            return created;
        } catch (Exception error) {
            if (created != null) try { activity.getContentResolver().delete(created, null, null); }
            catch (Exception ignored) {}
            throw error;
        } finally { doc.close(); }
    }

    private static final class PageWriter {
        final PDDocument document;
        final PDType0Font font;
        PDPageContentStream stream;
        float y;
        final float size = 10.5f;
        final float margin = 46f;
        PageWriter(PDDocument doc, PDType0Font font) throws Exception {
            this.document = doc; this.font = font; nextPage();
        }
        void nextPage() throws Exception {
            if (stream != null) stream.close();
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            stream = new PDPageContentStream(document, page);
            y = PDRectangle.A4.getHeight() - margin;
        }
        void paragraph(String text) throws Exception {
            if (text.trim().isEmpty()) { y -= 10f; return; }
            String remaining = text.trim().replaceAll("[\\p{Cntrl}&&[^\\n]]", "");
            float width = PDRectangle.A4.getWidth() - 2*margin;
            while (!remaining.isEmpty()) {
                int cut = remaining.length();
                while (cut > 1 && font.getStringWidth(clean(remaining.substring(0, cut)))
                        * size / 1000f > width) {
                    cut = cut > 70 ? cut - 10 : cut - 1;
                }
                if (cut < remaining.length()) {
                    int space = remaining.lastIndexOf(' ', cut);
                    if (space > 2) cut = space;
                }
                String line = clean(remaining.substring(0, cut).trim());
                draw(line);
                remaining = remaining.substring(cut).trim();
            }
        }
        static String clean(String text) {
            StringBuilder sb = new StringBuilder(text.length());
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '\t') sb.append(' ');
                else if (Character.isHighSurrogate(c)) {
                    sb.append('?'); if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i+1))) i++;
                } else if (!Character.isLowSurrogate(c) && (c >= 32)) sb.append(c);
            }
            return sb.toString();
        }
        void draw(String text) throws Exception {
            if (y < margin + 16) nextPage();
            stream.beginText();
            stream.setFont(font, size);
            stream.newLineAtOffset(margin, y);
            try { stream.showText(text); }
            catch (IllegalArgumentException e) { stream.showText("[СИМВОЛЫ НЕ ПОДДЕРЖИВАЮТСЯ]"); }
            stream.endText();
            y -= 15f;
        }
        void close() throws Exception { if (stream != null) { stream.close(); stream = null; } }
    }

    private static byte[] readBounded(InputStream in, int limit) throws Exception {
        if (in == null) throw new IllegalStateException("Файл недоступен");
        try (InputStream source = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[32768];
            int n;
            while ((n = source.read(b)) != -1) {
                if (out.size() + n > limit) throw new IllegalArgumentException("Слишком большой PDF, максимум 12 МБ");
                out.write(b, 0, n);
            }
            return out.toByteArray();
        }
    }

    public void shutdown() { worker.shutdown(); }
}
