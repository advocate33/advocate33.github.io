package ru.family.privatescan;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.MediaActionSound;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import org.opencv.android.OpenCVLoader;

import java.io.File;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * True hands-free serial capture. Detect -> stable & sharp -> AF -> shoot -> wait for
 * paper removal -> armed for next sheet. One explicit Finish button saves the batch.
 */
public final class AutoScanActivity extends ComponentActivity {
    private static final int CAMERA_REQUEST=504;
    private static final int MAX_PAGES=CascadeProcessing.MAX_PAGES;
    private PreviewView preview;
    private ScanOutlineView scanOutline;
    private MediaActionSound shutterSound;
    private TextView status;
    private TextView counter;
    private Button finish;
    private ExecutorService analyzerExecutor;
    private ExecutorService processingExecutor;
    private ProcessCameraProvider provider;
    private ImageCapture capture;
    private Camera camera;
    private File workingDir;
    private final ArrayList<File> rawFiles=new ArrayList<>();
    private final ArrayList<File> improvedFiles=new ArrayList<>();
    private final Object lock=new Object();
    private volatile boolean armed=true;
    private volatile boolean taking=false;
    private volatile boolean saving=false;
    private volatile boolean waitingForRemoval=false;
    private int stableFrames=0;
    private int missingFrames=0;
    private float lastX=-1,lastY=-1,lastArea=0;
    private long stableStart=0;
    private long lastAnalysis=0;
    private long lastShot=0;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        shutterSound=new MediaActionSound();
        shutterSound.load(MediaActionSound.SHUTTER_CLICK);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        try {
            if(!OpenCVLoader.initDebug())
                throw new IllegalStateException("Не загружена библиотека OpenCV");
        } catch (Exception e) {
            new AlertDialog.Builder(this).setTitle("Недоступна обработка документов")
                .setMessage(e.getMessage()).setPositiveButton("Закрыть",(d,w)->finish()).show();
            return;
        }
        workingDir=new File(getCacheDir(),"cascade_"+System.currentTimeMillis());
        if(!workingDir.mkdirs()) {Toast.makeText(this,"Нет доступа к временной памяти",Toast.LENGTH_LONG).show();finish();return;}
        analyzerExecutor=Executors.newSingleThreadExecutor();
        processingExecutor=Executors.newSingleThreadExecutor();
        FrameLayout root=new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        preview=new PreviewView(this);
        preview.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        root.addView(preview,new FrameLayout.LayoutParams(-1,-1));
        scanOutline=new ScanOutlineView(this);
        root.addView(scanOutline,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout column=new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(18,25,18,20);
        FrameLayout.LayoutParams overlayParams=new FrameLayout.LayoutParams(-1,-2,Gravity.TOP);
        root.addView(column,overlayParams);
        counter=new TextView(this);
        counter.setTextSize(24);counter.setTextColor(Color.WHITE);
        counter.setText("0 / "+MAX_PAGES+" страниц");
        counter.setGravity(Gravity.CENTER);
        column.addView(counter);
        status=new TextView(this);
        status.setText("Наведите на документ и держите камеру неподвижно");
        status.setTextSize(15);status.setTextColor(Color.WHITE);
        status.setGravity(Gravity.CENTER);
        status.setPadding(10,18,10,12);
        status.setBackgroundColor(0x990F2233);
        column.addView(status);
        LinearLayout controls=new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setPadding(15,12,15,25);
        FrameLayout.LayoutParams lp=new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM);
        root.addView(controls,lp);
        Button cancel=new Button(this);
        cancel.setText("Отмена");
        cancel.setOnClickListener(v->confirmDiscard());
        controls.addView(cancel,new LinearLayout.LayoutParams(0,-2,1));
        Button undo=new Button(this);
        undo.setText("Убрать лист");
        undo.setOnClickListener(v->undoLast());
        controls.addView(undo,new LinearLayout.LayoutParams(0,-2,1));
        finish=new Button(this);
        finish.setText("Готово • PDF");
        finish.setOnClickListener(v->saveBatch());
        controls.addView(finish,new LinearLayout.LayoutParams(0,-2,1));
        if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED) startCamera();
        else requestPermissions(new String[]{Manifest.permission.CAMERA},CAMERA_REQUEST);
    }

    @Override public void onRequestPermissionsResult(int req,String[] perms,int[] grants){
        super.onRequestPermissionsResult(req,perms,grants);
        if(req==CAMERA_REQUEST) {
            if(grants.length>0 && grants[0]==PackageManager.PERMISSION_GRANTED)startCamera();
            else {show("Без доступа к камере серийная съёмка невозможна");finish();}
        }
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> future=ProcessCameraProvider.getInstance(this);
        future.addListener(()->{
            try {
                if(isFinishing())return;
                provider=future.get();
                Preview p=new Preview.Builder()
                        .setTargetAspectRatio(androidx.camera.core.AspectRatio.RATIO_4_3).build();
                p.setSurfaceProvider(preview.getSurfaceProvider());
                capture=new ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setFlashMode(ImageCapture.FLASH_MODE_OFF)
                        .build();
                ImageAnalysis analysis=new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setTargetResolution(new android.util.Size(640,480))
                        .build();
                analysis.setAnalyzer(analyzerExecutor,this::analyzeFrame);
                provider.unbindAll();
                camera=provider.bindToLifecycle(this,CameraSelector.DEFAULT_BACK_CAMERA,p,capture,analysis);
                show("Наведите камеру на первый лист. Снимок будет сделан автоматически.");
            } catch(Exception e) {show("Камера недоступна: "+e.getMessage());}
        },ContextCompat.getMainExecutor(this));
    }

    private void analyzeFrame(ImageProxy image) {
        try {
            if(saving || taking || isFinishing())return;
            long now=SystemClock.elapsedRealtime();
            if(now-lastAnalysis<130)return; // native processing around 6 fps
            lastAnalysis=now;
            ImageProxy.PlaneProxy plane=image.getPlanes()[0];
            ByteBuffer b=plane.getBuffer();
            byte[] y=new byte[b.remaining()];
            b.get(y);
            CascadeProcessing.Detection d=CascadeProcessing.detectGray(y,image.getWidth(),
                    image.getHeight(),plane.getRowStride());
            final int orient=image.getImageInfo().getRotationDegrees();
            final int frameW=image.getWidth(),frameH=image.getHeight();
            int uiMode=waitingForRemoval ? ScanOutlineView.REMOVE_PAGE :
                    (d.found ? ScanOutlineView.STABLE : ScanOutlineView.SEARCHING);
            // ImageProxy will be closed below; capture immutable dimensions now.
            if(scanOutline!=null)runOnUiThread(()->scanOutline.detection(
                    d.quad,frameW,frameH,orient,uiMode));
            synchronized(lock) {
                if(waitingForRemoval) {
                    // Require the photographed sheet to disappear before re-arming.
                    if(!d.found || d.coverage<.18f)missingFrames++; else missingFrames=0;
                    if(missingFrames>=4) {
                        waitingForRemoval=false;armed=true;stableFrames=0;lastX=-1;
                        show("Готов к следующему листу — наведите камеру");
                        if(scanOutline!=null)runOnUiThread(()->scanOutline.state(ScanOutlineView.SEARCHING));
                    }
                    return;
                }
                if(!armed)return;
                if(!d.found || d.coverage<.20f) {
                    stableFrames=0;lastX=-1;show("Наведите на документ; все четыре края должны быть видны");
                    return;
                }
                if(d.sharpness<35f) {
                    stableFrames=0;lastX=-1;show("Изображение размыто: удерживайте телефон ровно");
                    return;
                }
                boolean steady=lastX>=0 && Math.abs(d.cx-lastX)<.025
                        && Math.abs(d.cy-lastY)<.025
                        && Math.abs(d.coverage-lastArea)<.065;
                if(steady)stableFrames++;
                else {stableFrames=1;stableStart=now;}
                lastX=d.cx;lastY=d.cy;lastArea=d.coverage;
                if(stableFrames<5 || now-stableStart<700L) {
                    show("Документ обнаружен • стабилизация и фокус…");
                    return;
                }
                if(now-lastShot<1700)return;
                armed=false;stableFrames=0;
                runOnUiThread(()->focusAndShoot(d.cx,d.cy));
            }
        } catch(Exception e) {
            show("Обработка кадра: "+e.getClass().getSimpleName());
        } finally {image.close();}
    }

    private void focusAndShoot(float cx,float cy) {
        if(camera==null || capture==null || saving)return;
        taking=true;
        show("Фокусировка и автоматический снимок…");
        if(scanOutline!=null)scanOutline.state(ScanOutlineView.CAPTURING);
        float px=Math.max(0,Math.min(preview.getWidth()-1,cx*preview.getWidth()));
        float py=Math.max(0,Math.min(preview.getHeight()-1,cy*preview.getHeight()));
        FocusMeteringAction action=new FocusMeteringAction.Builder(
                preview.getMeteringPointFactory().createPoint(px,py))
                .setAutoCancelDuration(3,TimeUnit.SECONDS).build();
        try {
            ListenableFuture<androidx.camera.core.FocusMeteringResult> future=
                    camera.getCameraControl().startFocusAndMetering(action);
            future.addListener(()->{
                try {
                    if(future.get().isFocusSuccessful()) takePhoto();
                    else {
                        taking=false;armed=true;show("Не удалось сфокусироваться — повторяю");
                    }
                } catch(Exception error) {
                    taking=false;armed=true;show("Автофокус не завершён — попробуйте снова");
                }
            },ContextCompat.getMainExecutor(this));
        }catch(Exception error){
            taking=false;armed=true;show("Автофокус не поддерживается камерой");
        }
    }

    private void takePhoto(){
        if(saving)return;
        if(rawFiles.size()>=MAX_PAGES) {
            taking=false;
            armed=false;
            waitingForRemoval=true;
            takeReadyUi("Достигнут лимит 40 страниц; нажмите Готово");
            return;
        }
        File file=new File(workingDir,"page_"+System.currentTimeMillis()+".jpg");
        ImageCapture.OutputFileOptions options=new ImageCapture.OutputFileOptions.Builder(file).build();
        capture.takePicture(options,ContextCompat.getMainExecutor(this),
                new ImageCapture.OnImageSavedCallback() {
            @Override public void onImageSaved(ImageCapture.OutputFileResults output) {
                synchronized(lock) {
                    rawFiles.add(file);
                    lastShot=SystemClock.elapsedRealtime();
                    waitingForRemoval=true;missingFrames=0;taking=false;
                }
                int count=rawFiles.size();
                counter.setText(count+" / "+MAX_PAGES+" страниц");
                if(shutterSound!=null) shutterSound.play(MediaActionSound.SHUTTER_CLICK);
                if(scanOutline!=null)scanOutline.shot(count);
                show("✓ СТРАНИЦА "+count+" СНЯТА. Уберите лист и наведите следующий.");
            }
            @Override public void onError(ImageCaptureException exception) {
                taking=false;armed=true;
                if(file.exists())file.delete();
                show("Ошибка снимка: "+exception.getMessage());
            }
        });
    }

    private void undoLast(){
        synchronized(lock) {
            if(saving||taking)return;
            if(!rawFiles.isEmpty())rawFiles.remove(rawFiles.size()-1).delete();
            waitingForRemoval=true;missingFrames=0;armed=false;
        }
        counter.setText(rawFiles.size()+" / "+MAX_PAGES+" страниц");
        show("Последний лист удалён. Уберите документ для нового снимка.");
    }

    private void takeReadyUi(String message){runOnUiThread(()->status.setText(message));}
    private void show(String s){if(status!=null)runOnUiThread(()->status.setText(s));}

    private void saveBatch(){
        if(saving)return;
        if(taking){show("Идёт съёмка — дождитесь завершения");return;}
        if(rawFiles.isEmpty()) {show("Нет снятых страниц");return;}
        saving=true;
        finish.setEnabled(false);
        provider.unbindAll();
        final ArrayList<File> pages=new ArrayList<>(rawFiles);
        processingExecutor.execute(()->{
            try {
                // If earlier processing was interrupted, regenerate cleaned pages from raw photos.
                for(File old:improvedFiles) old.delete();
                improvedFiles.clear();
                // Batch improvement only after all pages were captured.
                for(int i=0;i<pages.size();i++){
                    int index=i+1;
                    show("Улучшаю и выравниваю страницы: "+index+" / "+pages.size());
                    File processed=new File(workingDir,"clean_"+i+".jpg");
                    CascadeProcessing.processPhoto(pages.get(i),processed);
                    improvedFiles.add(processed);
                }
                show("Собираю единый PDF A4…");
                String stamp=new java.text.SimpleDateFormat("yyyy-MM-dd_HH-mm-ss",
                        java.util.Locale.ROOT).format(new java.util.Date());
                android.net.Uri clean=CascadeProcessing.exportPdf(this,
                        improvedFiles,"Скан_"+stamp+"_A4.pdf");
                android.net.Uri original=CascadeProcessing.exportPdf(this,
                        pages,"Скан_"+stamp+"_ОРИГИНАЛ.pdf");
                runOnUiThread(()->{
                    new AlertDialog.Builder(this).setTitle("Сканирование завершено")
                        .setMessage("Обработано страниц: "+pages.size()
                          + ". Созданы общий улучшенный PDF A4 и копия исходных снимков. "
                          + "Для поиска текста используйте локальное OCR в списке файлов.")
                        .setPositiveButton("К документам",(d,w)->{setResult(RESULT_OK);finish();})
                        .setCancelable(false).show();
                });
            }catch(Exception e){
                show("Ошибка итоговой обработки: "+e.getMessage());
                runOnUiThread(()->{
                    saving=false;finish.setEnabled(true);
                    new AlertDialog.Builder(this).setTitle("Не удалось создать PDF")
                        .setMessage(e.getMessage()+"\nСнимки остаются в памяти этой сессии. "
                                +"Можно повторить сохранение.")
                        .setPositiveButton("Повторить",(d,w)->saveBatch())
                        .setNegativeButton("Закрыть",null).show();
                });
            }
        });
    }

    private void confirmDiscard(){
        if(saving) {
            Toast.makeText(this,"Идёт обработка серии; дождитесь завершения",Toast.LENGTH_SHORT).show();
            return;
        }
        new AlertDialog.Builder(this).setTitle("Отменить серию?")
            .setMessage("Несохранённые снимки будут удалены.")
            .setNegativeButton("Продолжить",null)
            .setPositiveButton("Удалить серию",(d,w)->finish()).show();
    }
    @Override public void onBackPressed(){confirmDiscard();}
    @Override protected void onDestroy(){
        super.onDestroy();
        if(provider!=null) provider.unbindAll();
        if(analyzerExecutor!=null)analyzerExecutor.shutdownNow();
        if(shutterSound!=null)shutterSound.release();
        if(processingExecutor!=null)processingExecutor.shutdown();
        // clean only after final export; retries need these photos until screen closes
        if(workingDir!=null && workingDir.exists()) {
            File[] files=workingDir.listFiles();
            if(files!=null)for(File f:files)f.delete();
            workingDir.delete();
        }
    }
}
