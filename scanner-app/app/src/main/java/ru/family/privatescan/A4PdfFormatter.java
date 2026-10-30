package ru.family.privatescan;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.pdf.PdfDocument;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;

import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Fits every original scanner PDF page on ISO A4 without cropping.
 * The untouched original remains in Documents/PrivateScan.
 * Scan capture and document cleaning are performed by ML Kit SCANNER_MODE_FULL.
 */
public final class A4PdfFormatter {
    public interface Listener {
        void onProgress(int current, int total);
        void onSuccess(Uri saved, int pages);
        void onError(String message);
    }
    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private static final int MAX_PAGES = 75;
    private static final float PORTRAIT_W = 595.276f; // ISO A4, points
    private static final float PORTRAIT_H = 841.89f;
    private static final float MARGIN_PT = 17f;
    private static final float RENDER_SCALE = 3.75f; // ~270 dpi at 72 dpi page units
    private static final int MAX_EDGE_PX = 3600;
    private static final long MAX_PIXELS = 12_000_000L;
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";

    public void format(Activity activity, Uri original, String sourceName, Listener listener) {
        queue.execute(() -> {
            Uri destination = null;
            try {
                ContentResolver resolver = activity.getContentResolver();
                try (ParcelFileDescriptor source = resolver.openFileDescriptor(original, "r");
                     PdfRenderer input = new PdfRenderer(source)) {
                    PdfDocument output = new PdfDocument();
                    try {
                    if (source == null) throw new IllegalStateException("PDF не открывается");
                    int count = input.getPageCount();
                    if (count < 1 || count > MAX_PAGES)
                        throw new IllegalArgumentException("Допустимое количество страниц: 1–" + MAX_PAGES);
                    for (int index = 0; index < count; index++) {
                        int pageNumber = index + 1;
                        activity.runOnUiThread(() -> listener.onProgress(pageNumber, count));
                        try (PdfRenderer.Page page = input.openPage(index)) {
                            float inputW = page.getWidth();
                            float inputH = page.getHeight();
                            if (inputW <= 0 || inputH <= 0) throw new IllegalStateException("Неверные размеры страницы");
                            boolean landscape = inputW > inputH;
                            float pageW = landscape ? PORTRAIT_H : PORTRAIT_W;
                            float pageH = landscape ? PORTRAIT_W : PORTRAIT_H;
                            int outW = Math.round(pageW);
                            int outH = Math.round(pageH);
                            float scale = RENDER_SCALE;
                            scale = Math.min(scale, MAX_EDGE_PX / Math.max(inputW, inputH));
                            scale = Math.min(scale, (float) Math.sqrt(MAX_PIXELS / (inputW * inputH)));
                            int bitmapW = Math.max(1, Math.round(inputW * scale));
                            int bitmapH = Math.max(1, Math.round(inputH * scale));
                            Bitmap render = Bitmap.createBitmap(bitmapW, bitmapH, Bitmap.Config.ARGB_8888);
                            try {
                                render.eraseColor(Color.WHITE);
                                page.render(render, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT);
                                PdfDocument.Page a4 = output.startPage(
                                        new PdfDocument.PageInfo.Builder(outW, outH, pageNumber).create());
                                Canvas canvas = a4.getCanvas();
                                canvas.drawColor(Color.WHITE);

                                float freeW = pageW - 2f * MARGIN_PT;
                                float freeH = pageH - 2f * MARGIN_PT;
                                float contain = Math.min(freeW / bitmapW, freeH / bitmapH);
                                float drawW = bitmapW * contain;
                                float drawH = bitmapH * contain;
                                float x = (pageW - drawW) * 0.5f;
                                float y = (pageH - drawH) * 0.5f;

                                Paint correction = new Paint(Paint.ANTI_ALIAS_FLAG
                                        | Paint.FILTER_BITMAP_FLAG | Paint.DITHER_FLAG);
                                // Gentle contrast: preserve colors, stamps and faint handwriting.
                                float c = 1.035f, b = -3f;
                                ColorMatrix matrix = new ColorMatrix(new float[]{
                                        c,0,0,0,b,
                                        0,c,0,0,b,
                                        0,0,c,0,b,
                                        0,0,0,1,0
                                });
                                correction.setColorFilter(new ColorMatrixColorFilter(matrix));
                                canvas.drawBitmap(render, null, new RectF(x, y, x + drawW, y + drawH), correction);
                                output.finishPage(a4);
                            } finally {
                                render.recycle();
                            }
                        }
                    }

                    String clean = sourceName.replaceAll("(?i)\\.pdf$", "")
                            .replaceAll("[/\\\\:*?\"<>|]", "_");
                    if (clean.length() > 90) clean = clean.substring(0, 90);
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME,
                            clean + "_A4_" + System.currentTimeMillis() + ".pdf");
                    values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    destination = resolver.insert(MediaStore.Files.getContentUri(
                            MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
                    if (destination == null) throw new IllegalStateException("Нельзя сохранить PDF A4");
                    try (OutputStream out = resolver.openOutputStream(destination, "w")) {
                        if (out == null) throw new IllegalStateException("Ошибка записи PDF");
                        output.writeTo(out);
                    }
                    ContentValues ready = new ContentValues();
                    ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(destination, ready, null, null);
                    Uri saved = destination;
                    activity.runOnUiThread(() -> listener.onSuccess(saved, count));
                    } finally {
                        output.close();
                    }
                }
            } catch (Exception error) {
                if (destination != null) {
                    try { activity.getContentResolver().delete(destination, null, null); }
                    catch (Exception ignored) { }
                }
                String text = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
                activity.runOnUiThread(() -> listener.onError(text));
            }
        });
    }

    public void shutdown() { queue.shutdown(); }
}
