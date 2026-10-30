package ru.family.privatescan;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;

import com.googlecode.tesseract.android.TessBaseAPI;
import com.googlecode.tesseract.android.TessBaseAPI.PageIteratorLevel;
import com.googlecode.tesseract.android.ResultIterator;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.font.PDType0Font;
import com.tom_roush.pdfbox.pdmodel.graphics.state.RenderingMode;
import com.tom_roush.pdfbox.util.Matrix;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Offline Russian/English OCR. Original PDF page content is never replaced:
 * an invisible Unicode word layer is appended to each original PDF page.
 * Traineddata and font are bundled in APK by the CI workflow.
 */
public final class OfflineOcr {
    public interface Listener {
        void onProgress(int index, int total);
        void onSuccess(Uri output, int wordCount);
        void onError(String reason);
    }
    private static final int MAX_PAGES = 45;
    private static final int MAX_BYTES = 45 * 1024 * 1024;
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private static final class Word {
        final String text;
        final int left, top, right, bottom;
        Word(String t, int l, int y, int r, int b) {
            text = t; left = l; top = y; right = r; bottom = b;
        }
    }

    public void run(Activity activity, Uri source, String name, Listener listener) {
        executor.execute(() -> {
            File temp = null;
            Uri output = null;
            try {
                temp = File.createTempFile("ps_ocr_", ".pdf", activity.getCacheDir());
                copyToCache(activity, source, temp);
                File datapath = new File(activity.getFilesDir(), "ocr");
                prepareTrainedData(activity, datapath);
                File fontFile = prepareFont(activity);
                PDFBoxResourceLoader.init(activity.getApplicationContext());
                TessBaseAPI tess = new TessBaseAPI();
                try {
                    if (!tess.init(datapath.getAbsolutePath(), "rus+eng"))
                        throw new IllegalStateException("Не удалось запустить локальное OCR");
                    try (ParcelFileDescriptor pfd = ParcelFileDescriptor.open(temp, ParcelFileDescriptor.MODE_READ_ONLY);
                         PdfRenderer renderer = new PdfRenderer(pfd);
                         PDDocument doc = PDDocument.load(temp)) {
                        int total = renderer.getPageCount();
                        if (total < 1 || total > MAX_PAGES)
                            throw new IllegalArgumentException("Разрешено от 1 до " + MAX_PAGES + " страниц за один запуск");
                        if (doc.getNumberOfPages() != total)
                            throw new IllegalStateException("Количество PDF-страниц не совпадает");
                        PDType0Font font;
                        try (InputStream fontStream = new java.io.FileInputStream(fontFile)) {
                            font = PDType0Font.load(doc, fontStream, true);
                        }
                        int wordsTotal = 0;
                        for (int i = 0; i < total; i++) {
                            int current = i + 1;
                            activity.runOnUiThread(() -> listener.onProgress(current, total));
                            try (PdfRenderer.Page renderPage = renderer.openPage(i)) {
                                int width = Math.max(1, Math.round(renderPage.getWidth() * 2.5f));
                                int height = Math.max(1, Math.round(renderPage.getHeight() * 2.5f));
                                float downsample = Math.min(1f, (float) 3000 / Math.max(width, height));
                                width = Math.max(1, Math.round(width * downsample));
                                height = Math.max(1, Math.round(height * downsample));
                                Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                                try {
                                    bitmap.eraseColor(Color.WHITE);
                                    renderPage.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                                    tess.setImage(bitmap);
                                    // Recognition is performed before result iteration.
                                    tess.getUTF8Text();
                                    ArrayList<Word> words = readWords(tess);
                                    wordsTotal += words.size();
                                    addInvisibleLayer(doc, doc.getPage(i), font, words, width, height);
                                    tess.clear();
                                } finally {
                                    bitmap.recycle();
                                }
                            }
                        }
                        if (wordsTotal == 0) throw new IllegalStateException("Не удалось распознать текст на страницах");
                        ContentResolver resolver = activity.getContentResolver();
                        ContentValues cv = new ContentValues();
                        String safe = name.replaceAll("(?i)\\.pdf$", "").replaceAll("[/\\\\:*?\"<>|]", "_");
                        cv.put(MediaStore.MediaColumns.DISPLAY_NAME,
                                safe + "_SEARCHABLE_" + System.currentTimeMillis() + ".pdf");
                        cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                        cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                        output = resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), cv);
                        if (output == null) throw new IllegalStateException("Не удалось создать PDF");
                        try (OutputStream out = resolver.openOutputStream(output, "w")) {
                            if (out == null) throw new IllegalStateException("Не удалось открыть запись PDF");
                            doc.save(out);
                        }
                        ContentValues ready = new ContentValues();
                        ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        resolver.update(output, ready, null, null);
                        Uri done = output;
                        int count = wordsTotal;
                        activity.runOnUiThread(() -> listener.onSuccess(done, count));
                    }
                } finally {
                    tess.recycle();
                }
            } catch (Exception error) {
                if (output != null)
                    try { activity.getContentResolver().delete(output, null, null); }
                    catch (Exception ignored) {}
                String info = error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName();
                activity.runOnUiThread(() -> listener.onError(info));
            } finally {
                if (temp != null) temp.delete();
            }
        });
    }

    private static ArrayList<Word> readWords(TessBaseAPI tess) {
        ArrayList<Word> words = new ArrayList<>();
        ResultIterator iterator = tess.getResultIterator();
        if (iterator == null) return words;
        try {
            iterator.begin();
            do {
                String text = iterator.getUTF8Text(PageIteratorLevel.RIL_WORD);
                int[] box = iterator.getBoundingBox(PageIteratorLevel.RIL_WORD);
                if (text == null || box == null || box.length < 4) continue;
                text = text.trim();
                if (text.isEmpty() || box[2] <= box[0] || box[3] <= box[1]) continue;
                // Keep low-confidence results searchable. Do not silently replace words.
                words.add(new Word(text, box[0], box[1], box[2], box[3]));
            } while (iterator.next(PageIteratorLevel.RIL_WORD));
        } finally { iterator.delete(); }
        return words;
    }

    private static void addInvisibleLayer(PDDocument doc, PDPage page, PDType0Font font,
                                           ArrayList<Word> words, int width, int height) throws Exception {
        float pageWidth = page.getCropBox().getWidth();
        float pageHeight = page.getCropBox().getHeight();
        float xScale = pageWidth / width;
        float yScale = pageHeight / height;
        float xStart = page.getCropBox().getLowerLeftX();
        float yStart = page.getCropBox().getLowerLeftY();
        try (PDPageContentStream stream = new PDPageContentStream(doc, page,
                PDPageContentStream.AppendMode.APPEND, true, true)) {
            for (Word word : words) {
                float x = xStart + word.left * xScale;
                float y = yStart + pageHeight - word.bottom * yScale;
                float wordHeight = Math.max(4, (word.bottom - word.top) * yScale);
                float fontSize = Math.max(4, Math.min(26, wordHeight));
                float desiredWidth = Math.max(1, (word.right - word.left) * xScale);
                String normalized = word.text.replace("\u0000", "").replace("\n", " ").trim();
                if (normalized.isEmpty()) continue;
                try {
                    float measured = font.getStringWidth(normalized) * fontSize / 1000f;
                    if (measured <= 0) continue;
                    float stretch = Math.max(15, Math.min(350, (desiredWidth / measured) * 100));
                    stream.beginText();
                    stream.setFont(font, fontSize);
                    stream.setRenderingMode(RenderingMode.NEITHER);
                    stream.setHorizontalScaling(stretch);
                    stream.setTextMatrix(Matrix.getTranslateInstance(x, y));
                    stream.showText(normalized);
                    stream.endText();
                } catch (IllegalArgumentException e) {
                    // Rare unsupported Unicode glyph: leave scan intact rather than fail.
                }
            }
        }
    }

    private static void copyToCache(Activity activity, Uri uri, File temp) throws Exception {
        long total = 0;
        try (InputStream in = activity.getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(temp)) {
            if (in == null) throw new IllegalStateException("Нет доступа к PDF");
            byte[] buffer = new byte[32768];
            int count;
            while ((count = in.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) throw new IllegalArgumentException("Максимум 45 МБ");
                out.write(buffer, 0, count);
            }
        }
    }

    private static void prepareTrainedData(Activity activity, File root) throws Exception {
        File folder = new File(root, "tessdata");
        if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Нельзя создать OCR-папку");
        for (String language : new String[]{"rus", "eng"}) {
            String name = language + ".traineddata";
            File file = new File(folder, name);
            if (file.isFile() && file.length() > 500_000) continue;
            File part = new File(folder, name + ".tmp");
            try (InputStream in = activity.getAssets().open("tessdata/" + name);
                 OutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[32768];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
            if (part.length() < 500_000 || (!part.renameTo(file)))
                throw new IllegalStateException("Повреждена языковая модель " + name);
        }
    }

    private static File prepareFont(Activity activity) throws Exception {
        File font = new File(activity.getFilesDir(), "NotoSans-Regular.ttf");
        if (font.exists() && font.length() > 100_000) return font;
        File tmp = new File(activity.getFilesDir(), "NotoSans-Regular.ttf.tmp");
        try (InputStream in = activity.getAssets().open("fonts/NotoSans-Regular.ttf");
             OutputStream out = new FileOutputStream(tmp)) {
            byte[] b = new byte[16384];
            int n; while ((n = in.read(b)) != -1) out.write(b, 0, n);
        }
        if (tmp.length() < 100_000 || !tmp.renameTo(font))
            throw new IllegalStateException("Не удалось подготовить шрифт OCR");
        return font;
    }

    public void shutdown() { executor.shutdown(); }
}
