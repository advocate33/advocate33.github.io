package ru.family.privatescan;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.pdf.PdfDocument;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.exifinterface.media.ExifInterface;

import org.opencv.android.Utils;
import org.opencv.core.Core;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.MatOfPoint;
import org.opencv.core.MatOfPoint2f;
import org.opencv.core.Point;
import org.opencv.core.Rect;
import org.opencv.core.Scalar;
import org.opencv.core.Size;
import org.opencv.imgproc.Imgproc;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Only local processing; no document is uploaded. */
public final class CascadeProcessing {
    private CascadeProcessing() {}
    public static final int A4_W = 2480;
    public static final int A4_H = 3508; // 300 dpi
    public static final int MAX_PAGES = 40;
    private static final String FOLDER = Environment.DIRECTORY_DOCUMENTS + "/PrivateScan/";

    public static final class Detection {
        public final boolean found;
        public final float cx, cy, coverage, sharpness;
        /** Normalized source-image quadrilateral, clockwise. Null when no contour. */
        public final float[] quad;
        public Detection(boolean found, float cx, float cy, float coverage, float sharpness, float[] quad) {
            this.found=found; this.cx=cx; this.cy=cy; this.coverage=coverage;
            this.sharpness=sharpness; this.quad=quad;
        }
    }

    /**
     * Uses native ImageProxy Y plane (luminance), sampled into 400px image.
     * Returns bounded contour and Laplacian variance, no RGB allocations per frame.
     */
    public static Detection detectGray(byte[] luminance, int width, int height, int rowStride) {
        if (width < 16 || height < 16 || rowStride < width) return new Detection(false,0,0,0,0,null);
        int scale = Math.max(1, Math.max(width, height)/480);
        int w=Math.max(1,width/scale), h=Math.max(1,height/scale);
        Mat gray = new Mat(h,w,CvType.CV_8UC1);
        Mat edges = new Mat();
        Mat blurred = new Mat();
        Mat lap = new Mat();
        Mat hierarchy = new Mat();
        ArrayList<MatOfPoint> contours = new ArrayList<>();
        try {
            byte[] shrunk = new byte[w*h];
            for (int y=0;y<h;y++) {
                int srcY=Math.min(height-1,y*scale);
                int start = srcY*rowStride;
                for(int x=0;x<w;x++) shrunk[y*w+x]=luminance[start+Math.min(width-1,x*scale)];
            }
            gray.put(0,0,shrunk);
            Imgproc.GaussianBlur(gray,blurred,new Size(5,5),0);
            Imgproc.Laplacian(blurred,lap,CvType.CV_64F);
            org.opencv.core.MatOfDouble avg=new org.opencv.core.MatOfDouble();
            org.opencv.core.MatOfDouble std=new org.opencv.core.MatOfDouble();
            Core.meanStdDev(lap,avg,std);
            double[] stds=std.toArray();
            float focus = stds.length>0 ? (float)(stds[0]*stds[0]) : 0f;
            avg.release(); std.release();

            Imgproc.Canny(blurred,edges,60,155);
            Imgproc.dilate(edges,edges,Imgproc.getStructuringElement(Imgproc.MORPH_RECT,new Size(3,3)));
            Imgproc.findContours(edges,contours,hierarchy,Imgproc.RETR_LIST,Imgproc.CHAIN_APPROX_SIMPLE);
            double best=0;
            org.opencv.core.Rect bestBox=null;
            float[] bestQuad=null;
            for(MatOfPoint contour:contours) {
                double area=Imgproc.contourArea(contour);
                if (area < w*h*.17 || area > w*h*.96 || area <= best) continue;
                MatOfPoint2f poly=new MatOfPoint2f(contour.toArray());
                MatOfPoint2f approx=new MatOfPoint2f();
                double perimeter=Imgproc.arcLength(poly,true);
                Imgproc.approxPolyDP(poly,approx, .025*perimeter, true);
                if(approx.total()==4 && Imgproc.isContourConvex(new MatOfPoint(approx.toArray()))) {
                    org.opencv.core.Rect b=Imgproc.boundingRect(contour);
                    if(b.width > w*.30 && b.height > h*.30) {
                        best=area;bestBox=b;
                        Point[] points=approx.toArray();
                        bestQuad=new float[8];
                        for(int k=0;k<4;k++){
                            bestQuad[k*2]=(float)(points[k].x/w);
                            bestQuad[k*2+1]=(float)(points[k].y/h);
                        }
                    }
                }
                poly.release();approx.release();
            }
            if(bestBox==null) return new Detection(false,0,0,0,focus,null);
            return new Detection(true,(bestBox.x+bestBox.width*.5f)/w,
                    (bestBox.y+bestBox.height*.5f)/h,(float)(best/(w*h)),focus,bestQuad);
        } finally {
            gray.release(); edges.release();blurred.release();lap.release();hierarchy.release();
            for(MatOfPoint c:contours)c.release();
        }
    }

    private static Point[] corners(Mat gray) {
        Mat edges=new Mat(),smooth=new Mat(),hierarchy=new Mat();
        ArrayList<MatOfPoint> contours=new ArrayList<>();
        try {
            Imgproc.GaussianBlur(gray,smooth,new Size(5,5),0);
            Imgproc.Canny(smooth,edges,50,140);
            Imgproc.dilate(edges,edges,Imgproc.getStructuringElement(Imgproc.MORPH_RECT,new Size(5,5)));
            Imgproc.findContours(edges,contours,hierarchy,Imgproc.RETR_LIST,Imgproc.CHAIN_APPROX_SIMPLE);
            double winning=0;Point[] winner=null;
            for(MatOfPoint contour:contours) {
                double area=Imgproc.contourArea(contour);
                if(area<gray.width()*gray.height()*.15 || area>gray.width()*gray.height()*.98 || area<winning)
                    continue;
                MatOfPoint2f c=new MatOfPoint2f(contour.toArray()),p=new MatOfPoint2f();
                try {
                    Imgproc.approxPolyDP(c,p, .024*Imgproc.arcLength(c,true), true);
                    if(p.total()!=4 || !Imgproc.isContourConvex(new MatOfPoint(p.toArray())))continue;
                    winner=p.toArray();winning=area;
                } finally {c.release();p.release();}
            }
            if(winner==null)return null;
            Point[] order=new Point[4];
            for(Point p:winner) {
                // nearest to each corner by sums/differences
            }
            Point tl=null,tr=null,br=null,bl=null;
            double sumMin=Double.MAX_VALUE,sumMax=-Double.MAX_VALUE;
            double diffMin=Double.MAX_VALUE,diffMax=-Double.MAX_VALUE;
            for(Point p:winner) {
                double sum=p.x+p.y, diff=p.y-p.x;
                if(sum<sumMin){sumMin=sum;tl=p;}
                if(sum>sumMax){sumMax=sum;br=p;}
                if(diff<diffMin){diffMin=diff;tr=p;}
                if(diff>diffMax){diffMax=diff;bl=p;}
            }
            if(tl==tr || tr==br || br==bl || bl==tl)return null;
            return new Point[]{tl,tr,br,bl};
        } finally {
            edges.release();smooth.release();hierarchy.release();
            for(MatOfPoint m:contours)m.release();
        }
    }

    public static void processPhoto(File rawPhoto, File output) throws Exception {
        BitmapFactory.Options opts=new BitmapFactory.Options();
        opts.inJustDecodeBounds=true;
        BitmapFactory.decodeFile(rawPhoto.getAbsolutePath(),opts);
        int longer=Math.max(opts.outWidth,opts.outHeight);
        if(longer<=0)throw new IllegalStateException("Не удалось открыть фотографию");
        opts.inSampleSize=longer>4400?2:1;
        opts.inJustDecodeBounds=false;
        Bitmap decoded=BitmapFactory.decodeFile(rawPhoto.getAbsolutePath(),opts);
        if(decoded==null)throw new IllegalStateException("Неверный снимок");
        Bitmap oriented=null;
        Mat rgba=new Mat(),gray=new Mat(),outputMat=new Mat();
        try {
            int orientation=new ExifInterface(rawPhoto.getAbsolutePath())
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            int angle=orientation==ExifInterface.ORIENTATION_ROTATE_90 ? 90 :
                    orientation==ExifInterface.ORIENTATION_ROTATE_180 ? 180 :
                    orientation==ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
            if(angle!=0) {
                Matrix matrix=new Matrix();matrix.postRotate(angle);
                oriented=Bitmap.createBitmap(decoded,0,0,decoded.getWidth(),decoded.getHeight(),matrix,true);
                decoded.recycle();decoded=oriented;
            }
            Utils.bitmapToMat(decoded,rgba);
            Imgproc.cvtColor(rgba,gray,Imgproc.COLOR_RGBA2GRAY);
            Point[] quad=corners(gray);
            // Always export a portrait A4 page, regardless of camera sensor rotation.
            int targetW=A4_W,targetH=A4_H;
            if(quad!=null) {
                MatOfPoint2f src=new MatOfPoint2f(quad);
                MatOfPoint2f dest=new MatOfPoint2f(new Point(0,0),new Point(targetW-1,0),
                        new Point(targetW-1,targetH-1),new Point(0,targetH-1));
                Mat trans=Imgproc.getPerspectiveTransform(src,dest);
                try {Imgproc.warpPerspective(rgba,outputMat,trans,new Size(targetW,targetH),
                        Imgproc.INTER_CUBIC,Core.BORDER_CONSTANT,new Scalar(255,255,255,255));}
                finally{src.release();dest.release();trans.release();}
            } else {
                outputMat=new Mat(targetH,targetW,CvType.CV_8UC4,new Scalar(255,255,255,255));
                double factor=Math.min((double)targetW/rgba.width(),(double)targetH/rgba.height());
                int w=Math.min(targetW,Math.max(1,(int)(rgba.width()*factor)));
                int h=Math.min(targetH,Math.max(1,(int)(rgba.height()*factor)));
                Mat resized=new Mat();
                try {
                    Imgproc.resize(rgba,resized,new Size(w,h),0,0,Imgproc.INTER_AREA);
                    int x=(targetW-w)/2,y=(targetH-h)/2;
                    resized.copyTo(outputMat.submat(new Rect(x,y,w,h)));
                }finally{resized.release();}
            }
            Mat lab=new Mat(),rgb=new Mat();
            try {
                Imgproc.cvtColor(outputMat,rgb,Imgproc.COLOR_RGBA2RGB);
                Imgproc.cvtColor(rgb,lab,Imgproc.COLOR_RGB2Lab);
                List<Mat> channels=new ArrayList<>();
                Core.split(lab,channels);
                try {
                    org.opencv.imgproc.CLAHE clahe=Imgproc.createCLAHE(1.5,new Size(8,8));
                    clahe.apply(channels.get(0),channels.get(0));
                    Core.merge(channels,lab);
                } finally {for(Mat m:channels)m.release();}
                Imgproc.cvtColor(lab,rgb,Imgproc.COLOR_Lab2RGB);
                Mat blur=new Mat();
                try {
                    Imgproc.GaussianBlur(rgb,blur,new Size(0,0),1.0);
                    Core.addWeighted(rgb,1.2,blur,-.2,0,rgb);
                } finally {blur.release();}
                Bitmap result=Bitmap.createBitmap(targetW,targetH,Bitmap.Config.ARGB_8888);
                try {
                    Imgproc.cvtColor(rgb,outputMat,Imgproc.COLOR_RGB2RGBA);
                    Utils.matToBitmap(outputMat,result);
                    try(OutputStream out=new java.io.FileOutputStream(output)) {
                        if(!result.compress(Bitmap.CompressFormat.JPEG,93,out))
                            throw new IllegalStateException("Ошибка записи обработанной страницы");
                    }
                } finally {result.recycle();}
            } finally {lab.release();rgb.release();}
        }finally{
            if(decoded!=null && !decoded.isRecycled())decoded.recycle();
            rgba.release();gray.release();outputMat.release();
        }
    }

    public static Uri exportPdf(Context context,List<File> pageImages,String filename) throws Exception {
        if(pageImages.isEmpty())throw new IllegalArgumentException("Нет снятых страниц");
        ContentResolver resolver=context.getContentResolver();
        ContentValues meta=new ContentValues();
        meta.put(MediaStore.MediaColumns.DISPLAY_NAME,filename);
        meta.put(MediaStore.MediaColumns.MIME_TYPE,"application/pdf");
        meta.put(MediaStore.MediaColumns.RELATIVE_PATH,FOLDER);
        meta.put(MediaStore.MediaColumns.IS_PENDING,1);
        Uri destination=resolver.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),meta);
        if(destination==null)throw new IllegalStateException("PDF не создаётся");
        PdfDocument pdf=new PdfDocument();
        try {
            for(int i=0;i<pageImages.size();i++){
                File f=pageImages.get(i);
                BitmapFactory.Options opt=new BitmapFactory.Options();
                opt.inSampleSize=1;
                Bitmap bitmap=BitmapFactory.decodeFile(f.getAbsolutePath(),opt);
                if(bitmap==null)throw new IllegalStateException("Повреждена страница "+(i+1));
                try {
                    // Always create portrait A4 pages. Fit without cropping original content.
                    int width=595,height=842;
                    PdfDocument.Page page=pdf.startPage(new PdfDocument.PageInfo.Builder(width,height,i+1).create());
                    Canvas canvas=page.getCanvas();
                    canvas.drawColor(Color.WHITE);
                    float ratio=Math.min((float)width/bitmap.getWidth(),(float)height/bitmap.getHeight());
                    float w=bitmap.getWidth()*ratio,h=bitmap.getHeight()*ratio;
                    canvas.drawBitmap(bitmap,null,new RectF((width-w)/2,(height-h)/2,
                            (width+w)/2,(height+h)/2),new Paint(Paint.FILTER_BITMAP_FLAG));
                    pdf.finishPage(page);
                }finally{bitmap.recycle();}
            }
            try(OutputStream stream=resolver.openOutputStream(destination,"w")){
                if(stream==null)throw new IllegalStateException("Нет доступа для записи");
                pdf.writeTo(stream);
            }
            ContentValues ready=new ContentValues();ready.put(MediaStore.MediaColumns.IS_PENDING,0);
            resolver.update(destination,ready,null,null);
            return destination;
        }catch(Exception e){resolver.delete(destination,null,null);throw e;}
        finally{pdf.close();}
    }
}
