#!/usr/bin/env python3
"""Structural smoke test for the v20 patcher without Android SDK or network.
Does NOT prove APK compilation/compatibility and is not a server security test.
"""
import ast
import os
from pathlib import Path
import subprocess
import sys
import tempfile

project = Path(__file__).resolve().parents[1]
patcher = project/'tools/apply_family_mode.py'
source = patcher.read_text(encoding='utf-8')
tree = ast.parse(source)
anchors = {'main': [], 'gradle': [], 'update_app': [], 'trusted_wifi': [], 'tunnel_service': []}
for node in ast.walk(tree):
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ('replace_once', 'replace_exactly'):
        try:
            which = node.args[0].id
            before = ast.literal_eval(node.args[1])
        except (ValueError, AttributeError):
            continue
        repeat = ast.literal_eval(node.args[3]) if node.func.id == 'replace_exactly' else 1
        anchors.setdefault(which, []).extend([before] * repeat)

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    paths = {
        'main': root/'app/src/main/java/com/wdtt/plus/MainActivity.kt',
        'gradle': root/'app/build.gradle.kts',
        'update_app': root/'app/src/main/java/com/wdtt/plus/AppUpdate.kt',
        'trusted_wifi': root/'app/src/main/java/com/wdtt/plus/TrustedWifi.kt',
        'tunnel_service': root/'app/src/main/java/com/wdtt/plus/TunnelService.kt',
    }
    for which,path in paths.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        header = 'val appVersionCode = 20\n' if which == 'gradle' else ''
        path.write_text(header + '\n'.join(anchors[which]) + '\n', encoding='utf-8')
    (root/'README.md').write_text('WDTT Plus\n', encoding='utf-8')
    (root/'server.go').write_text('\n'.join([
        'GETCONF:',
        'valid && isGenPass && entry.DeviceID != "" && entry.DeviceID != deviceID',
        'DENIED:device_mismatch',
        'if isGenPass && entry.DeviceID == "" {',
        'entry.DeviceID = deviceID',
        'if err := saveDB(); err != nil {',
        'isMainPass := password != "" && password == db.MainPassword',
        'entry, isGenPass := db.Passwords[password]',
    ]), encoding='utf-8')
    (root/'app/src/main/java/com/wdtt/plus/DeviceIdentity.kt').write_text(
        'fun valid(value: String)\nfun resolve(\n', encoding='utf-8'
    )
    tools = root/'tools'
    tools.mkdir(exist_ok=True)
    for name in ('FamilyHomeScreen.kt','FamilyUpdater.kt','FamilyWifiPolicy.kt','verify_device_binding.py','apply_family_mode.py'):
        (tools/name).write_bytes((project/'tools'/name).read_bytes())
    (root/'config').mkdir(exist_ok=True)
    (root/'config/approved-server-version.txt').write_text('20\n')
    env = dict(os.environ, FAMILY_UPDATE_REPO='test/familyvpn', FAMILY_BUILD_NUMBER='8')
    run = subprocess.run([sys.executable, str(tools/'apply_family_mode.py')],cwd=root,env=env,capture_output=True,text=True)
    assert run.returncode == 0, f'{run.stdout}\n{run.stderr}'
    patched = paths['gradle'].read_text()
    assert 'applicationId = "ru.familyvpn.wdtt"' in patched
    assert 'versionCode = 20 * 100000 + 8' in patched
    assert '"FAMILY_UPDATE_REPO", "\\"test/familyvpn\\""' in patched
    assert 'androidx.work:work-runtime-ktx' in patched
    updated = paths['update_app'].read_text()
    assert 'BuildConfig.FAMILY_UPDATE_REPO' in updated
    assert (paths['main'].parent/'FamilyUpdater.kt').is_file()
    assert (paths['main'].parent/'FamilyHomeScreen.kt').is_file()
    assert (paths['main'].parent/'FamilyWifiPolicy.kt').is_file()
    assert 'FAMILY_WIFI_PSEUDO_SSID' in paths['trusted_wifi'].read_text()
    assert 'BuildConfig.FAMILY_MODE || store.trustedWifiEnabled.first()' in paths['tunnel_service'].read_text()
    assert 'FamilyWifiPolicy.isConnected(applicationContext)' in paths['tunnel_service'].read_text()
    assert 'FamilyUpdateNotice()' in paths['main'].read_text()
    second = subprocess.run([sys.executable, str(tools/'apply_family_mode.py')],cwd=root,env=env,capture_output=True,text=True)
    assert second.returncode != 0, 'Patch must not silently apply twice'
    print('PASS: patch anchors, Wi-Fi pause/resume integration, family updates, idempotence')
    print('LIMITATION: Android/Go build and on-device tests not performed')
