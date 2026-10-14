// SPDX-License-Identifier: GPL-3.0-or-later
// Update service for the separately signed FamilyVPN APK. Never installs donor APK.
package com.wdtt.plus

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

internal object FamilyUpdateControl {
    val manualCheckSequence = MutableStateFlow(0)
    val result = MutableStateFlow("")
    fun requestManualCheck() { manualCheckSequence.value += 1 }
}

private const val WEEK_MILLIS = 7L * 24L * 60L * 60L * 1000L
private const val LAST_CHECK_PREFS = "family_update_weekly"
private const val LAST_CHECK_KEY = "last_successful_check"

internal data class FamilyUpdate(
    val versionCode: Int,
    val versionName: String,
    val asset: AppReleaseAsset,
)

// Fixed at build time, never read from an incoming VPN profile, URL or QR code.
private fun familyRepo(): String? = BuildConfig.FAMILY_UPDATE_REPO
    .takeIf { it.matches(Regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) }

internal suspend fun findFamilyUpdate(): FamilyUpdate? = withContext(Dispatchers.IO) {
    val repo = familyRepo() ?: return@withContext null
    val connection = (URL("https://api.github.com/repos/$repo/releases?per_page=50")
        .openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        instanceFollowRedirects = false
        connectTimeout = 12_000
        readTimeout = 12_000
        setRequestProperty("Accept", "application/vnd.github+json")
        setRequestProperty("User-Agent", "FamilyVPN/${BuildConfig.VERSION_NAME}")
        useCaches = false
    }
    try {
        if (connection.responseCode != 200) throw IOException("Сервер обновлений вернул HTTP ${connection.responseCode}")
        if (connection.contentLengthLong > 512 * 1024) throw IOException("Некорректный ответ обновления")
        val body = connection.inputStream.bufferedReader().use { it.readText().take(512 * 1024 + 1) }
        require(body.length <= 512 * 1024) { "Превышен размер метаданных обновления" }
        val releases = org.json.JSONArray(body)
        var best: FamilyUpdate? = null
        for (j in 0 until releases.length()) {
            val json = releases.optJSONObject(j) ?: continue
            if (json.optBoolean("draft") || json.optBoolean("prerelease")) continue
            val tag = json.optString("tag_name")
            if (!tag.matches(Regex("^family-v[0-9]+-[a-f0-9]{10}$"))) continue
            val assets = json.optJSONArray("assets") ?: continue
            for (i in 0 until assets.length()) {
                val entry = assets.optJSONObject(i) ?: continue
                val filename = entry.optString("name")
                val versionCode = Regex("^FamilyVPN-(\\d+)\\.apk$").matchEntire(filename)
                    ?.groupValues?.get(1)?.toIntOrNull() ?: continue
                if (versionCode <= BuildConfig.VERSION_CODE || (best != null && versionCode <= best.versionCode)) continue
                val download = entry.optString("browser_download_url")
                val sha = entry.optString("digest").removePrefix("sha256:").lowercase()
                val bytes = entry.optLong("size", -1L)
                val prefix = "https://github.com/$repo/releases/download/$tag/"
                if (!download.startsWith(prefix, ignoreCase = true) || !download.endsWith("/$filename") ||
                    !sha.matches(Regex("[0-9a-f]{64}")) || bytes !in 1..200_000_000L) continue
                best = FamilyUpdate(versionCode,
                    json.optString("name").ifBlank { "Семейный VPN $versionCode" },
                    AppReleaseAsset(filename, download, bytes, "sha256:$sha"))
            }
        }
        best
    } finally {
        connection.disconnect()
    }
}

internal object FamilyUpdateNotifier {
    private const val CHANNEL = "family_vpn_updates"
    private const val PREFS = "family_vpn_update_notifications"
    fun notifyOnce(context: Context, update: FamilyUpdate) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getInt("last_version", 0) >= update.versionCode) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL, "Обновления семейного VPN", NotificationManager.IMPORTANCE_DEFAULT,
            ))
        }
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            context, 903, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        manager.notify(903, NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile_logo)
            .setContentTitle("Обновление Семейного VPN")
            .setContentText("Доступна проверенная сборка. Откройте приложение для обновления.")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build())
        prefs.edit().putInt("last_version", update.versionCode).apply()
    }
}

class FamilyUpdateWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = try {
        findFamilyUpdate()?.let { FamilyUpdateNotifier.notifyOnce(applicationContext, it) }
        applicationContext.getSharedPreferences(LAST_CHECK_PREFS, Context.MODE_PRIVATE)
            .edit().putLong(LAST_CHECK_KEY, System.currentTimeMillis()).apply()
        Result.success()
    } catch (_: Exception) {
        // Do not harm the working VPN if GitHub is blocked/offline.
        Result.retry()
    }
}

private fun ensureFamilyBackgroundChecks(context: Context) {
    val request = PeriodicWorkRequestBuilder<FamilyUpdateWorker>(7, TimeUnit.DAYS).build()
    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        "family-vpn-version-watch", ExistingPeriodicWorkPolicy.UPDATE, request,
    )
}

@Composable
fun FamilyUpdateNotice() {
    if (!BuildConfig.FAMILY_MODE || familyRepo() == null) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val manualSequence by FamilyUpdateControl.manualCheckSequence.collectAsStateWithLifecycle()
    var candidate by remember { mutableStateOf<FamilyUpdate?>(null) }
    var downloading by remember { mutableStateOf(false) }
    var dismissedVersion by remember { mutableStateOf(0) }
    var progress by remember { mutableStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(manualSequence) {
        ensureFamilyBackgroundChecks(context.applicationContext)
        val prefs = context.getSharedPreferences(LAST_CHECK_PREFS, Context.MODE_PRIVATE)
        val lastCheck = prefs.getLong(LAST_CHECK_KEY, 0L)
        val now = System.currentTimeMillis()
        // A manual check is requested by explicit button click. Automatic checks happen
        // no more frequently than once per week; WorkManager also uses 7-day cadence.
        if (manualSequence == 0 && lastCheck > 0 && now - lastCheck < WEEK_MILLIS) return@LaunchedEffect
        val result = runCatching { findFamilyUpdate() }
        if (result.isSuccess) {
            prefs.edit().putLong(LAST_CHECK_KEY, now).apply()
            val update = result.getOrNull()
            if (update != null && update.versionCode > dismissedVersion) {
                candidate = update
                FamilyUpdateNotifier.notifyOnce(context.applicationContext, update)
            }
            if (manualSequence > 0) FamilyUpdateControl.result.value =
                if (update != null) "Доступна новая версия" else "Обновлений пока нет"
        } else if (manualSequence > 0) {
            FamilyUpdateControl.result.value = "Не удалось проверить обновления: нет доступа к GitHub"
        }
    }
    val update = candidate ?: return
    AlertDialog(
        onDismissRequest = { if (!downloading) { dismissedVersion = update.versionCode; candidate = null } },
        title = { Text("Обновление Семейного VPN") },
        text = {
            Column {
                Text("Выпущена ${update.versionName}. Персональный доступ сохранится, если обновление подписано нашим ключом.")
                Spacer(Modifier.height(12.dp))
                if (downloading) {
                    CircularProgressIndicator()
                    if (progress > 0f) LinearProgressIndicator(progress = { progress })
                }
                error?.let { Text("Ошибка: $it") }
            }
        },
        confirmButton = {
            Button(onClick = {
                if (downloading) return@Button
                downloading = true
                error = null
                scope.launch {
                    try {
                        // Donor's updater performs SHA-256 AND matching APK-signature verification.
                        val apk = downloadUpdateApk(context, update.asset) { step ->
                            progress = step.fraction ?: 0f
                        }
                        if (!canRequestApkInstall(context)) {
                            error = "Разрешите установку из этого приложения в настройках Android и повторите."
                            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:${context.packageName}"))
                            context.startActivity(settings)
                        } else {
                            installUpdateApk(context, apk)
                            candidate = null
                        }
                    } catch (e: Exception) {
                        error = e.localizedMessage ?: "Не удалось проверить APK."
                    } finally {
                        downloading = false
                    }
                }
            }, enabled = !downloading) { Text("Скачать и установить") }
        },
        dismissButton = {
            TextButton(onClick = { dismissedVersion = update.versionCode; candidate = null }, enabled = !downloading) { Text("Позже") }
        },
    )
}
