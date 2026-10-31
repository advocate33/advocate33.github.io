package ru.family.privatescan;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.View;

/** Outline for the actual detected quadrilateral, transformed from CameraX Y-plane
 * sensor coordinates to the portrait PreviewView FILL_CENTER coordinate system.
 */
public final class ScanOutlineView extends View {
    public static final int SEARCHING=0, STABLE=1, CAPTURING=2, CAPTURED=3, REMOVE_PAGE=4;
    private final Paint stroke=new Paint(3);
    private final Paint textPaint=new Paint(3);
    private final Paint shadow=new Paint(3);
    private volatile float[] corners;
    private volatile int rawWidth=0,rawHeight=0,rotation=0;
    private volatile int mode=SEARCHING, pageCount=0;
    private volatile long flashUntil=0;

    public ScanOutlineView(Context context) {
        super(context);
        setClickable(false);
        setFocusable(false);
        setLayerType(View.LAYER_TYPE_SOFTWARE,null);
        textPaint.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        textPaint.setTextAlign(Paint.Align.CENTER);
        shadow.setStyle(Paint.Style.FILL);
    }

    public void detection(float[] normalized,int w,int h,int degrees,int state) {
        // Called on main thread; never retain mutable native image buffers.
        corners=normalized==null?null:normalized.clone();
        rawWidth=w;rawHeight=h;rotation=degrees;
        mode=state;
        invalidate();
    }

    public void shot(int count) {
        pageCount=count;
        mode=CAPTURED;
        flashUntil=SystemClock.uptimeMillis()+650;
        invalidate();
        postInvalidateDelayed(700);
    }

    public void state(int state) {
        mode=state;invalidate();
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w=getWidth(),h=getHeight();
        if(w<=0||h<=0)return;
        float dp=getResources().getDisplayMetrics().density;
        int cyan=Color.rgb(40,245,229);
        int amber=Color.rgb(255,196,75);
        int green=Color.rgb(70,244,155);
        int color=mode==STABLE?green:(mode==CAPTURING?amber:cyan);

        if(corners!=null && corners.length==8 && rawWidth>0 && rawHeight>0) {
            float rotatedW=(rotation==90 || rotation==270)?rawHeight:rawWidth;
            float rotatedH=(rotation==90 || rotation==270)?rawWidth:rawHeight;
            // PreviewView uses FILL_CENTER: account for cropping rather than stretching polygon.
            float scale=Math.max(w/rotatedW,h/rotatedH);
            float dx=(w-rotatedW*scale)*.5f,dy=(h-rotatedH*scale)*.5f;
            Path path=new Path();
            for(int i=0;i<4;i++) {
                float x=corners[2*i],y=corners[2*i+1],rx=x,ry=y;
                if(rotation==90){rx=1f-y;ry=x;}
                else if(rotation==180){rx=1f-x;ry=1f-y;}
                else if(rotation==270){rx=y;ry=1f-x;}
                float sx=dx+rx*rotatedW*scale,sy=dy+ry*rotatedH*scale;
                if(i==0)path.moveTo(sx,sy);else path.lineTo(sx,sy);
            }
            path.close();
            stroke.setColor(Color.argb(25,0,255,219));
            stroke.setStyle(Paint.Style.FILL);
            canvas.drawPath(path,stroke);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeWidth(3.5f*dp);
            stroke.setColor(color);
            stroke.setStrokeJoin(Paint.Join.ROUND);
            canvas.drawPath(path,stroke);
        } else {
            // Guide, not a falsely detected contour.
            RectF guide=new RectF(w*.1f,h*.18f,w*.9f,h*.82f);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeWidth(2.2f*dp);
            stroke.setColor(Color.argb(150,255,255,255));
            canvas.drawRoundRect(guide,12*dp,12*dp,stroke);
        }

        if(SystemClock.uptimeMillis()<flashUntil) {
            canvas.drawColor(Color.argb(68,255,255,255));
            shadow.setColor(Color.argb(224,4,82,62));
            canvas.drawRoundRect(new RectF(w*.13f,h*.43f,w*.87f,h*.57f),
                    15*dp,15*dp,shadow);
            textPaint.setTextSize(21*dp);
            textPaint.setColor(Color.WHITE);
            canvas.drawText("✓  СТРАНИЦА "+pageCount+" СНЯТА",w*.5f,h*.51f,textPaint);
        } else if(mode==REMOVE_PAGE) {
            shadow.setColor(Color.argb(190,10,30,40));
            canvas.drawRoundRect(new RectF(w*.10f,h*.46f,w*.9f,h*.54f),
                    13*dp,13*dp,shadow);
            textPaint.setColor(Color.WHITE);textPaint.setTextSize(16*dp);
            canvas.drawText("Уберите лист — затем следующий",w*.5f,h*.51f,textPaint);
        }
    }
}
