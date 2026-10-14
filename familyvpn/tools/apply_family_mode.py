#!/usr/bin/env python3
"""Apply idempotent family-UI patch to WDTT Plus v20 working tree.
No network calls, no passwords, no root required. Run from repository root.
"""
from pathlib import Path
import shutil
import sys
import os
import re
import json

root = Path.cwd()
main_path = root / 'app/src/main/java/com/wdtt/plus/MainActivity.kt'
gradle_path = root / 'app/build.gradle.kts'
source = Path(__file__).with_name('FamilyHomeScreen.kt')
updater_source = Path(__file__).with_name('FamilyUpdater.kt')
updater_target = root / 'app/src/main/java/com/wdtt/plus/FamilyUpdater.kt'
update_app_path = root / 'app/src/main/java/com/wdtt/plus/AppUpdate.kt'
approved_server_version_file = Path(__file__).parents[1] / 'config/approved-server-version.txt' 
target = root / 'app/src/main/java/com/wdtt/plus/FamilyHomeScreen.kt'
policy_guard = Path(__file__).with_name('verify_device_binding.py')
wifi_source = Path(__file__).with_name('FamilyWifiPolicy.kt')
wifi_target = root / 'app/src/main/java/com/wdtt/plus/FamilyWifiPolicy.kt'
trusted_wifi_path = root / 'app/src/main/java/com/wdtt/plus/TrustedWifi.kt'
tunnel_service_path = root / 'app/src/main/java/com/wdtt/plus/TunnelService.kt'

for path in (main_path, gradle_path, source, updater_source, update_app_path, policy_guard, approved_server_version_file, wifi_source, trusted_wifi_path, tunnel_service_path):
    if not path.is_file():
        sys.exit(f'ERROR: Not found: {path}. Run in WDTT Plus repository root.')

main = main_path.read_text(encoding='utf-8')
gradle = gradle_path.read_text(encoding='utf-8')
update_app = update_app_path.read_text(encoding='utf-8')
trusted_wifi = trusted_wifi_path.read_text(encoding='utf-8')
tunnel_service = tunnel_service_path.read_text(encoding='utf-8')
repo = os.environ.get('FAMILY_UPDATE_REPO', '').strip()
if repo and not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
    sys.exit('ERROR: FAMILY_UPDATE_REPO must be owner/repo')
build_number = int(os.environ.get('FAMILY_BUILD_NUMBER', '1'))
if build_number < 1 or build_number >= 100000:
    sys.exit('ERROR: FAMILY_BUILD_NUMBER must be 1..99999')
import subprocess
verified = subprocess.run([sys.executable, str(policy_guard)], cwd=root, check=False)
if verified.returncode:
    sys.exit('ERROR: family device-binding policy not verified; no patch applied.')

if 'FAMILY_MODE' in gradle:
    sys.exit('Family mode seems already applied. Nothing changed.')

def replace_once(text, before, after, name):
    count = text.count(before)
    if count != 1:
        sys.exit(f'ERROR: Unsupported WDTT revision, anchor {name}: found {count} times. No files changed.')
    return text.replace(before, after, 1)

# Distinct package name ensures it does not overwrite standard WDTT Plus installed on the owner's device.
gradle = replace_once(gradle,
    'applicationId = "com.wdtt.plus"',
    'applicationId = "ru.familyvpn.wdtt"\n'
    '        buildConfigField("boolean", "FAMILY_MODE", "true")\n'
    '        buildConfigField("String", "FAMILY_UPDATE_REPO", ' + json.dumps(json.dumps(repo)) + ')',
    'applicationId & family flags')
gradle = replace_once(gradle,
    'versionCode = 20\n        versionName = appVersionName',
    f'versionCode = appVersionCode * 100000 + {build_number}\n        versionName = appVersionName + ".family.{build_number}"',
    'family monotonic version')
gradle = replace_once(gradle,
    'implementation("androidx.core:core-ktx:1.15.0")',
    'implementation("androidx.core:core-ktx:1.15.0")\n    implementation("androidx.work:work-runtime-ktx:2.10.1")',
    'workmanager dependency')
gradle = replace_once(gradle,
    'manifestPlaceholders["appLabel"] = "WDTT Plus"',
    'manifestPlaceholders["appLabel"] = "Семейный VPN"', 'app label')
gradle = replace_once(gradle,
    'manifestPlaceholders["appLabel"] = "WDTT Plus Preview"',
    'manifestPlaceholders["appLabel"] = "Семейный VPN Тест"', 'debug app label')
# Disable upstream APK updater in separately signed and separately packaged derivative builds.
main = replace_once(main,
    '    suspend fun runUpdateCheck(\n        reason: String,\n        shouldRun: suspend () -> Boolean = { true }\n    ) {',
    '    suspend fun runUpdateCheck(\n        reason: String,\n        shouldRun: suspend () -> Boolean = { true }\n    ) {\n        if (BuildConfig.FAMILY_MODE) return',
    'upstream update check')
main = replace_once(main,
    'import androidx.activity.compose.setContent',
    'import androidx.activity.compose.setContent\nimport androidx.activity.compose.BackHandler',
    'Android back handler')
main = replace_once(main,
    '    var selectedTab by rememberSaveable { mutableIntStateOf(0) }',
    '    var selectedTab by rememberSaveable { mutableIntStateOf(0) }\n    var familyAdvanced by rememberSaveable { mutableStateOf(false) }\n    BackHandler(enabled = BuildConfig.FAMILY_MODE && familyAdvanced) {\n        familyAdvanced = false\n        selectedTab = 0\n    }',
    'family UI state')
main = replace_once(main,
    '    SideEffect(onUiReadyForFirstDraw)',
    '    SideEffect(onUiReadyForFirstDraw)\n    if (BuildConfig.FAMILY_MODE) FamilyUpdateNotice()',
    'family in-app updater')
main = replace_once(main,
    '    val navOverlayReserve = safeBottomInset + 96.dp',
    '    val navOverlayReserve = if (BuildConfig.FAMILY_MODE && !familyAdvanced) safeBottomInset + 12.dp else safeBottomInset + 96.dp',
    'bottom reserve')
main = replace_once(main,
'''    val activeNavItems = remember(
        wdttLinkMode,
        isAdminInterface,
        remoteManagedProfile,
    ) {
        navItems.filter { item ->''',
'''    val activeNavItems = remember(
        wdttLinkMode,
        isAdminInterface,
        remoteManagedProfile,
        familyAdvanced,
    ) {
        navItems.filter { item ->
            if (BuildConfig.FAMILY_MODE && !familyAdvanced && item.id != 0) return@filter false''',
    'simple navigation')
main = replace_once(main,
'''                            0 -> SettingsTab(
                                settingsStore = settingsStore,''',
'''                            0 -> if (BuildConfig.FAMILY_MODE && !familyAdvanced) {
                                FamilyHomeScreen(
                                    settingsStore = settingsStore,
                                    onImportLink = onIncomingTransferContent,
                                    onOpenTransfer = { showTransferCenter = true },
                                )
                            } else SettingsTab(
                                settingsStore = settingsStore,''',
    'family home rendering')
main = replace_once(main,
'''                ProxyNavigationBar(
                    navItems = activeNavItems,''',
'''                if (!BuildConfig.FAMILY_MODE || familyAdvanced) {
                ProxyNavigationBar(
                    navItems = activeNavItems,''',
    'navigation bar open')
main = replace_once(main,
'''                    modifier = Modifier.align(Alignment.BottomCenter)
                )
            }
        }

        // Floating theme toolbar overlay''',
'''                    modifier = Modifier.align(Alignment.BottomCenter)
                )
                }
            }
        }

        // Floating theme toolbar overlay''',
    'navigation bar close')
main = replace_once(main,
'''        // Floating theme toolbar overlay
        FloatingToolbar(''',
'''        // Floating theme toolbar overlay
        if (!BuildConfig.FAMILY_MODE || familyAdvanced) {
        FloatingToolbar(''',
    'toolbar open')
main = replace_once(main,
'''            onOpened = { navigationRevision++ }
        )
        SnackbarHost(''',
'''            onOpened = { navigationRevision++ }
        )
        }
        SnackbarHost(''',
    'toolbar close')

# Permit own GitHub release assets for downloadUpdateApk(), but do not relax HTTPS or signatures.
update_app = replace_once(update_app,
    '''return host == "github.com" &&
            uri.path.orEmpty().startsWith(
                "/Ivan4537/WDTT-Plus/releases/download/",
                ignoreCase = true,
            )''',
    '''return host == "github.com" &&
            (uri.path.orEmpty().startsWith("/Ivan4537/WDTT-Plus/releases/download/", ignoreCase = true) ||
                (BuildConfig.FAMILY_MODE && BuildConfig.FAMILY_UPDATE_REPO.isNotBlank() &&
                    uri.path.orEmpty().startsWith("/${BuildConfig.FAMILY_UPDATE_REPO}/releases/download/", ignoreCase = true)))''',
    'trusted family release URL')

# Family mode: physical Wi-Fi only; re-use donor's background TrustedWifi
# transition/wait/resume machinery rather than a UI-only connectivity callback.
trusted_wifi = replace_once(trusted_wifi,
    '    if (!wifiConnected) return ConnectedWifiState(connected = false)',
    '    if (!wifiConnected) return ConnectedWifiState(connected = false)\n'
    '    // Family builds treat EVERY physical Wi-Fi as trusted, without SSID/location.\n'
    '    if (BuildConfig.FAMILY_MODE) return ConnectedWifiState(connected = true, ssid = FAMILY_WIFI_PSEUDO_SSID)',
    'physical Wi-Fi SSID-independent family mode')

def replace_exactly(text, before, after, expected, name):
    found = text.count(before)
    if found != expected:
        sys.exit(f'ERROR: donor {name}: expected {expected} anchors, found {found}. Nothing changed.')
    return text.replace(before, after)

tunnel_service = replace_exactly(tunnel_service,
    'val enabled = store.trustedWifiEnabled.first()\n'
    '        val trustedSsids = store.trustedWifiSsids.first().toSet()',
    'val enabled = BuildConfig.FAMILY_MODE || store.trustedWifiEnabled.first()\n'
    '        val trustedSsids = if (BuildConfig.FAMILY_MODE) setOf(FAMILY_WIFI_PSEUDO_SSID) else store.trustedWifiSsids.first().toSet()',
    2, 'trusted Wi-Fi evaluation and start')
tunnel_service = replace_exactly(tunnel_service,
    'val wifi = readConnectedWifiState(applicationContext)',
    'val wifi = if (BuildConfig.FAMILY_MODE && FamilyWifiPolicy.isConnected(applicationContext)) {\n'
    '            ConnectedWifiState(connected = true, ssid = FAMILY_WIFI_PSEUDO_SSID)\n'
    '        } else readConnectedWifiState(applicationContext)',
    2, 'fail-closed physical Wi-Fi detection')
tunnel_service = replace_once(tunnel_service,
    'store.trustedWifiEnabled.first() &&\n                        store.trustedWifiWaiting.first()',
    '(BuildConfig.FAMILY_MODE || store.trustedWifiEnabled.first()) &&\n                        store.trustedWifiWaiting.first()',
    'waiting state restoration')
tunnel_service = replace_once(tunnel_service,
    'if (!enabled && trustedWifiWaiting) {',
    'if (!BuildConfig.FAMILY_MODE && !enabled && trustedWifiWaiting) {',
    'prevent disabling mandatory family Wi-Fi policy')
tunnel_service = replace_once(tunnel_service,
    'if (isWdttAlwaysOnVpn(applicationContext) && wifi.ssidAvailable && wifi.ssid in trustedSsids) {',
    'if (!BuildConfig.FAMILY_MODE && isWdttAlwaysOnVpn(applicationContext) && wifi.ssidAvailable && wifi.ssid in trustedSsids) {',
    'never start on Wi-Fi due to always-on exception')
tunnel_service = replace_once(tunnel_service,
    'if (isWdttAlwaysOnVpn(applicationContext) && !trustedWifiWaiting) {',
    'if (!BuildConfig.FAMILY_MODE && isWdttAlwaysOnVpn(applicationContext) && !trustedWifiWaiting) {',
    'family Wi-Fi is not exempt from evaluation')
tunnel_service = replace_once(tunnel_service,
    '        trustedWifiTransitionMutex.withLock {\n            if (!trustedWifiWaiting) return\n            if (!hasUsableRealNetworkForTrustedWifiResume()) {',
    '        trustedWifiTransitionMutex.withLock {\n            if (!trustedWifiWaiting) return\n'
    '            if (BuildConfig.FAMILY_MODE && FamilyWifiPolicy.isConnected(applicationContext)) return\n'
    '            if (!hasUsableRealNetworkForTrustedWifiResume()) {',
    'do not resume if Wi-Fi came back during handover')
# Wi-Fi may return during the asynchronous access refresh for mobile resume.
# Recheck at the last possible moment before the VPN transport actually starts.
tunnel_service = replace_once(tunnel_service,
    '            withContext(Dispatchers.Main) {\n                acquireTrustedWifiTransitionWakeLock()\n                Log.i("TunnelService", "Доверенная Wi-Fi покинута, запускаем VPN на рабочей сети")',
    '            withContext(Dispatchers.Main) {\n'
    '                if (BuildConfig.FAMILY_MODE && FamilyWifiPolicy.isConnected(applicationContext)) {\n'
    '                    scheduleTrustedWifiEvaluation(delayMs = 0L)\n'
    '                    return@withContext\n'
    '                }\n'
    '                acquireTrustedWifiTransitionWakeLock()\n'
    '                Log.i("TunnelService", "Доверенная Wi-Fi покинута, запускаем VPN на рабочей сети")',
    'recheck physical Wi-Fi at final resume')

# Shorten the transition delay for family: Wi-Fi should not run VK traffic
# for two seconds after an Android callback. Donor retains its debounce.
tunnel_service = replace_exactly(tunnel_service,
    'scheduleTrustedWifiEvaluation(TRUSTED_WIFI_ENTER_DELAY_MS)',
    'scheduleTrustedWifiEvaluation(if (BuildConfig.FAMILY_MODE) 0L else TRUSTED_WIFI_ENTER_DELAY_MS)',
    3, 'fast pause on Wi-Fi')

# Save backups only when all anchors matched successfully.
for path in (main_path, gradle_path, update_app_path, trusted_wifi_path, tunnel_service_path):
    backup = path.with_name(path.name + '.family-original')
    if not backup.exists():
        shutil.copyfile(path, backup)
main_path.write_text(main, encoding='utf-8')
gradle_path.write_text(gradle, encoding='utf-8')
update_app_path.write_text(update_app, encoding='utf-8')
trusted_wifi_path.write_text(trusted_wifi, encoding='utf-8')
tunnel_service_path.write_text(tunnel_service, encoding='utf-8')
shutil.copyfile(wifi_source, wifi_target)
shutil.copyfile(source, target)
shutil.copyfile(updater_source, updater_target)
print('OK: family UI, Wi-Fi-only mobile tunnel policy, device-binding guard, and weekly updates.')
print('NOTE: Build and real-device tests are still required.')
