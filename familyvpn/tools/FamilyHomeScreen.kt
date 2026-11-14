// SPDX-License-Identifier: GPL-3.0-or-later
// Family-mode UI extension for WDTT Plus v20 by Ivan4537 (GPLv3).
package com.wdtt.plus

import android.content.Intent
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.net.VpnService
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first

/** Family screen deliberately reuses original TunnelService / SettingsStore / access checks.
 * Initial provisioning is needed once; no embedded VPS IP, password, SSH key or VK hash.
 */
@Composable
fun FamilyHomeScreen(
    settingsStore: SettingsStore,
    onImportLink: (String) -> Unit,
    onOpenTransfer: () -> Unit,
) {
    val context = LocalContext.current
    // UI feedback; authoritative Wi-Fi pause/resume lives in TunnelService,
    // so it also runs with the screen off.
    var onWifi by remember { mutableStateOf(FamilyWifiPolicy.isConnected(context)) }
    DisposableEffect(context) {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val main = Handler(Looper.getMainLooper())
        val callback = object : ConnectivityManager.NetworkCallback() {
            private fun refresh() {
                main.post { onWifi = FamilyWifiPolicy.isConnected(context) }
            }
            override fun onAvailable(network: Network) = refresh()
            override fun onLost(network: Network) = refresh()
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = refresh()
        }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val registered = runCatching { manager.registerNetworkCallback(request, callback) }.isSuccess
        onWifi = FamilyWifiPolicy.isConnected(context)
        onDispose { if (registered) runCatching { manager.unregisterNetworkCallback(callback) } }
    }
    val scope = rememberCoroutineScope()
    val running by TunnelManager.running.collectAsStateWithLifecycle()
    val workers by TunnelManager.activeWorkers.collectAsStateWithLifecycle()
    val transition by TunnelManager.transition.collectAsStateWithLifecycle()
    val activeProfile by settingsStore.activeProfile.collectAsStateWithLifecycle(initialValue = 0)
    val trustedWaiting by TrustedWifiManager.state.collectAsStateWithLifecycle()
    val profile by settingsStore.activeTunnelProfileContentUiSnapshot.collectAsStateWithLifecycle()
    val updateResult by FamilyUpdateControl.result.collectAsStateWithLifecycle()
    // Hide profile import/export tools after initial provisioning. This is UI hygiene,
    // NOT the security boundary: real one-device enforcement is in wdtt-server.
    val hasPersonalAccess = profile?.let {
        it.link.isNotBlank() || (it.peer.isNotBlank() && it.connectionPassword.isNotBlank())
    } ?: false

    var showImport by remember { mutableStateOf(false) }
    var newLink by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var pendingVpnPermission by remember { mutableStateOf(false) }

    fun reportError(message: String) {
        error = message
        TunnelManager.clearTransition()
    }

    fun startServiceFromProfile() {
        if (FamilyWifiPolicy.isConnected(context)) {
            reportError("Подключён Wi-Fi — VPN работает только через мобильную сеть.")
            return
        }
        scope.launch {
            try {
                // Family app must not become a shareable SOCKS/HTTP LAN gateway.
                // This is client-side hardening; server-side device binding is the
                // authoritative access control.
                val mode = settingsStore.proxyMode.first()
                if (tunnelModeUsesLocalProxy(mode)) {
                    reportError("Для семейного доступа разрешён только VPN-режим. Обратитесь к администратору.")
                    return@launch
                }
                val intent = buildTunnelStartIntentFromSettings(context, activeProfile)
                if (intent == null) {
                    reportError("Сначала добавьте персональный доступ от администратора и VK-хеш, если он необходим.")
                    return@launch
                }
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
                else context.startService(intent)
            } catch (e: Exception) {
                reportError(e.localizedMessage ?: "Не удалось запустить VPN.")
            }
        }
    }

    val vpnPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        if (pendingVpnPermission) {
            pendingVpnPermission = false
            if (VpnService.prepare(context) == null) startServiceFromProfile()
            else reportError("VPN-разрешение не выдано. Нажмите «Подключить» ещё раз.")
        }
    }

    fun toggleConnection() {
        if (transition != TunnelTransition.IDLE) return
        error = null
        if (running || trustedWaiting.waiting) {
            TunnelManager.noteStopRequested()
            try {
                context.startService(Intent(context, TunnelService::class.java).setAction("STOP"))
            } catch (e: Exception) {
                reportError(e.localizedMessage ?: "Не удалось остановить VPN.")
            }
            return
        }
        if (FamilyWifiPolicy.isConnected(context)) {
            reportError("Wi-Fi подключён. Отключите Wi-Fi для использования семейного VPN.")
            return
        }
        TunnelManager.noteStartRequested()
        scope.launch {
            try {
                when (AccessLifecycleCoordinator.prepareStart(context, activeProfile)) {
                    AccessStartDecision.Allowed -> {
                        val mode = settingsStore.proxyMode.first()
                        if (tunnelModeNeedsVpnPermission(mode)) {
                            val request = VpnService.prepare(context)
                            if (request != null) {
                                pendingVpnPermission = true
                                vpnPermissionLauncher.launch(request)
                            } else startServiceFromProfile()
                        } else startServiceFromProfile()
                    }
                    is AccessStartDecision.Denied -> reportError("Доступ не разрешён или срок его действия истёк. Обратитесь к администратору.")
                }
            } catch (e: Exception) {
                reportError(e.localizedMessage ?: "Ошибка запуска соединения.")
            }
        }
    }

    val waiting = transition != TunnelTransition.IDLE
    val status = when {
        onWifi && running -> "Wi-Fi обнаружен: останавливаем туннель…"
        onWifi || trustedWaiting.waiting -> "Wi-Fi: VPN выключен"
        running && workers > 0 -> "Соединение установлено"
        running -> "Туннель запущен, ожидаем канал"
        waiting -> "Изменение состояния…"
        else -> "Не подключено"
    }
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Семейный VPN", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        Text(status, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        if (running) {
            Spacer(Modifier.height(4.dp))
            Text("Рабочих транспортных каналов: $workers", style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(34.dp))
        Button(
            onClick = ::toggleConnection,
            enabled = !waiting && (running || trustedWaiting.waiting || !onWifi),
            modifier = Modifier.fillMaxWidth().height(84.dp)
        ) {
            if (waiting) CircularProgressIndicator()
            else Text(
                if (running || trustedWaiting.waiting) "Отключить"
                else if (onWifi) "Доступно на мобильной сети"
                else "Подключить",
                style = MaterialTheme.typography.titleLarge,
            )
        }
        Spacer(Modifier.height(22.dp))
        if (onWifi) {
            Text(
                "VK-туннель не использует Wi-Fi. Звонки VK идут через обычное подключение.",
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
        }
        if (!hasPersonalAccess) {
            TextButton(onClick = { showImport = true }) { Text("Ввести персональную ссылку") }
            TextButton(onClick = onOpenTransfer) { Text("Получить доступ по QR-коду") }
            Spacer(Modifier.height(12.dp))
            Text(
                "Первое подключение закрепляет доступ за этим телефоном. " +
                    "Активируйте его вместе с владельцем сервера.",
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
            )
        } else {
            Text(
                "Доступ персональный: один телефон. " +
                    "Перенос, замена или сброс доступа — через администратора.",
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = { FamilyUpdateControl.requestManualCheck() }) {
            Text("Проверить обновления")
        }
        if (updateResult.isNotBlank()) {
            Text(updateResult, style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center)
        }
        if (error != null) {
            Spacer(Modifier.height(10.dp))
            Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }
    }

    if (showImport) {
        AlertDialog(
            onDismissRequest = { showImport = false },
            title = { Text("Добавить доступ") },
            text = {
                Column {
                    Text("Вставьте полученную от администратора ссылку wdtt:// или защищённую HTTPS-ссылку. Не пересылайте её посторонним.")
                    Spacer(Modifier.height(14.dp))
                    OutlinedTextField(
                        value = newLink,
                        onValueChange = { newLink = it.take(8192) },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Персональная ссылка") },
                        minLines = 2,
                        maxLines = 4,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = newLink.isNotBlank(),
                    onClick = {
                        onImportLink(newLink.trim())
                        newLink = ""
                        showImport = false
                    }
                ) { Text("Импортировать") }
            },
            dismissButton = { TextButton(onClick = { showImport = false }) { Text("Отмена") } },
        )
    }
}
