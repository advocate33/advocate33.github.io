package ru.family.privatescan;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.content.pm.PackageInstaller;
import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Checks releases only from owner's fixed public repository. Uses Android system
 * installer: never silently installs. Requires same appId and stable signing cert.
 */
public final class UpdateManager {
    private static final String RELEASES =
            "https://api.github.com/repos/advocate33/advocate33.github.io/releases?per_page=20";
    private static final String PREFIX = "https://github.com/advocate33/advocate33.github.io/releases/download/";
    private final ExecutorService background=Executors.newSingleThreadExecutor();
    private final Activity activity;
    public UpdateManager(Activity activity){this.activity=activity;}

    public void checkForUpdate() {
        new AlertDialog.Builder(activity)
            .setTitle("Проверить обновления")
            .setMessage("Проверю опубликованные версии PrivateScan на GitHub. "
                    + "Для установки будет использован стандартный установщик Android. "
                    + "Приложение никогда не устанавливает файлы без вашего подтверждения.")
            .setNegativeButton("Отмена",null)
            .setPositiveButton("Проверить",(d,w)->loadRelease()).show();
    }

    private void loadRelease(){
        toast("Проверяю GitHub Releases…");
        background.execute(()->{
            try {
                JSONArray list=new JSONArray(fetchText(RELEASES,700_000));
                int installed=activity.getPackageManager().getPackageInfo(
                        activity.getPackageName(),0).versionCode;
                int highest=installed;
                JSONObject candidate=null;
                String apkUrl=null,shaUrl=null;
                for(int i=0;i<list.length();i++){
                    JSONObject release=list.optJSONObject(i);
                    if(release==null || release.optBoolean("draft"))continue;
                    String tag=release.optString("tag_name","");
                    java.util.regex.Matcher matcher=java.util.regex.Pattern
                            .compile("^privatescan-v(\\d+)\\.(\\d+)(?:.*)$").matcher(tag);
                    if(!matcher.matches())continue;
                    int code=Integer.parseInt(matcher.group(1))*100+Integer.parseInt(matcher.group(2));
                    if(code<=highest)continue;
                    JSONArray assets=release.optJSONArray("assets");
                    if(assets==null)continue;
                    String foundApk=null,foundSha=null;
                    for(int j=0;j<assets.length();j++){
                        JSONObject a=assets.optJSONObject(j);
                        if(a==null)continue;
                        String name=a.optString("name","");
                        String url=a.optString("browser_download_url","");
                        if(!url.startsWith(PREFIX))continue;
                        if(name.endsWith(".apk")) foundApk=url;
                        if(name.equals("SHA256SUMS.txt"))foundSha=url;
                    }
                    if(foundApk!=null && foundSha!=null){
                        highest=code;candidate=release;apkUrl=foundApk;shaUrl=foundSha;
                    }
                }
                if(candidate==null){
                    alert("Обновлений нет","Установленная версия актуальна среди опубликованных "
                            +"тестовых версий. Проверка не изменяла приложение.");return;
                }
                final String url=apkUrl,checksumUrl=shaUrl;
                final String label=candidate.optString("tag_name","");
                activity.runOnUiThread(()->new AlertDialog.Builder(activity)
                    .setTitle("Найдено "+label)
                    .setMessage("Скачать APK с GitHub и проверить цифровую подпись? "
                        +"Установка возможна только если подпись разработчика совпадает "
                        +"с установленной версией. Размер загрузки — десятки мегабайт.")
                    .setNegativeButton("Отмена",null)
                    .setPositiveButton("Скачать и проверить",(d,w)->downloadAndInstall(url,checksumUrl))
                    .show());
            }catch(Exception e){alert("Ошибка проверки обновлений",errorText(e));}
        });
    }

    private void downloadAndInstall(String url,String checksumUrl){
        toast("Загружаю обновление…");
        background.execute(()->{
            File apk=null;
            try {
                if(!url.startsWith(PREFIX) || !checksumUrl.startsWith(PREFIX))
                    throw new SecurityException("Недоверенный адрес загрузки");
                File dir=new File(activity.getCacheDir(),"apk-updates");
                if(!dir.exists()&&!dir.mkdirs())
                    throw new IllegalStateException("Нет доступа к памяти обновлений");
                apk=new File(dir,"privatescan-new.apk");
                String checksum=fetchText(checksumUrl,8000);
                HttpURLConnection conn=open(url);
                try {
                    if(conn.getResponseCode()!=200)
                        throw new IllegalStateException("GitHub APK HTTP "+conn.getResponseCode());
                    long total=0;
                    try(InputStream in=conn.getInputStream();FileOutputStream out=new FileOutputStream(apk)){
                        byte[] block=new byte[65536];int n;
                        while((n=in.read(block))!=-1){
                            total+=n;if(total>250L*1024*1024)throw new IllegalStateException("Слишком большой APK");
                            out.write(block,0,n);
                        }
                    }
                    if(total<100_000)throw new IllegalStateException("Загружен неполный APK");
                }finally{conn.disconnect();}
                String expected=checksum.trim().split("\\s+")[0].toLowerCase(Locale.ROOT);
                String actual=hex(MessageDigest.getInstance("SHA-256")
                        .digest(java.nio.file.Files.readAllBytes(apk.toPath())));
                if(!expected.equals(actual))
                    throw new SecurityException("Контрольная сумма APK не совпадает");
                validateSamePackageAndSignature(apk);
                File toInstall=apk;
                activity.runOnUiThread(()->new AlertDialog.Builder(activity)
                    .setTitle("APK проверен")
                    .setMessage("Подпись и пакет совпадают. Установить обновление? "
                            +"Android может запросить разрешение на установку из этого приложения.")
                    .setNegativeButton("Отмена",null)
                    .setPositiveButton("Установить",(d,w)->install(toInstall))
                    .show());
            }catch(Exception error) {
                if(apk!=null)apk.delete();
                alert("Обновление не установлено",errorText(error));
            }
        });
    }

    private void validateSamePackageAndSignature(File file) throws Exception {
        PackageManager pm=activity.getPackageManager();
        PackageInfo remote=pm.getPackageArchiveInfo(
                file.getAbsolutePath(),PackageManager.GET_SIGNING_CERTIFICATES);
        PackageInfo current=pm.getPackageInfo(activity.getPackageName(),
                PackageManager.GET_SIGNING_CERTIFICATES);
        if(remote==null || remote.packageName==null)
            throw new SecurityException("Файл не распознан как Android APK");
        if(!remote.packageName.equals(current.packageName))
            throw new SecurityException("Это другой пакет Android. "
                  +"Нужна постоянная идентичность приложения для обновлений.");
        Signature[] currentSign=current.signingInfo.getApkContentsSigners();
        Signature[] remoteSign=remote.signingInfo.getApkContentsSigners();
        if(currentSign.length!=1||remoteSign.length!=1||
                !MessageDigest.isEqual(currentSign[0].toByteArray(),remoteSign[0].toByteArray()))
            throw new SecurityException("APK подписан другим ключом. "
                  +"Для обновлений необходимо настроить постоянный release keystore "
                  +"в GitHub Actions; тестовые debug-ключи от разных сборок несовместимы.");
        if(remote.getLongVersionCode()<=current.getLongVersionCode())
            throw new IllegalStateException("Версия APK не новее установленной");
    }

    private void install(File file){
        try {
            if(Build.VERSION.SDK_INT>=26 &&
                    !activity.getPackageManager().canRequestPackageInstalls()){
                new AlertDialog.Builder(activity).setTitle("Нужно разрешение Android")
                    .setMessage("Разрешите установку из PrivateScan в настройках Android, "
                            +"после этого снова нажмите «Проверить обновления».")
                    .setPositiveButton("Настройки",(d,w)->{
                        Intent i=new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:"+activity.getPackageName()));
                        activity.startActivity(i);
                    }).setNegativeButton("Отмена",null).show();
                return;
            }
            Uri share=FileProvider.getUriForFile(activity,
                    activity.getPackageName()+".fileprovider",file);
            Intent intent=new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(share,"application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(intent);
        }catch(Exception e){alert("Не удалось открыть установщик",errorText(e));}
    }

    private static HttpURLConnection open(String url) throws Exception{
        HttpURLConnection conn=(HttpURLConnection)new URL(url).openConnection();
        conn.setConnectTimeout(20_000);conn.setReadTimeout(60_000);
        conn.setRequestProperty("User-Agent","PrivateScan-Android-Updater");
        conn.setRequestProperty("Accept","application/vnd.github+json");
        return conn;
    }
    private static String fetchText(String url,int limit) throws Exception {
        HttpURLConnection conn=open(url);
        try {
            if(conn.getResponseCode()!=200)
                throw new IllegalStateException("GitHub HTTP "+conn.getResponseCode());
            try(InputStream in=conn.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buffer=new byte[8192];int count;
                while((count=in.read(buffer))!=-1){
                    if(out.size()+count>limit)throw new IllegalStateException("Слишком большой ответ");
                    out.write(buffer,0,count);
                }
                return out.toString("UTF-8");
            }
        }finally{conn.disconnect();}
    }
    private static String hex(byte[] bytes){
        StringBuilder s=new StringBuilder(bytes.length*2);
        for(byte b:bytes)s.append(String.format(Locale.ROOT,"%02x",b&255));
        return s.toString();
    }
    private static String errorText(Exception error) {
        return error.getMessage()==null?error.getClass().getSimpleName():error.getMessage();
    }
    private void toast(String msg){activity.runOnUiThread(()->
            android.widget.Toast.makeText(activity,msg,android.widget.Toast.LENGTH_LONG).show());}
    private void alert(String title,String msg){
        activity.runOnUiThread(()->new AlertDialog.Builder(activity)
                .setTitle(title).setMessage(msg).setPositiveButton("ОК",null).show());
    }
    public void shutdown(){background.shutdown();}
}
