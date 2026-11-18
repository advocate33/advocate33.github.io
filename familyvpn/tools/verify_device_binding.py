#!/usr/bin/env python3
"""Fail-closed source compatibility check for WDTT Plus v20 family use.

This test is NOT a cryptographic security audit. It checks the upstream code
contains the known first-device binding + rejection path and the Android client
resolves a per-device identifier. Run from the WDTT repository root.
"""
from pathlib import Path
import sys

root = Path.cwd()
server_path = root / "server.go"
device_path = root / "app/src/main/java/com/wdtt/plus/DeviceIdentity.kt"
readme_path = root / "README.md"
for p in (server_path, device_path, readme_path):
    if not p.is_file():
        sys.exit(f"FAIL: expected WDTT Plus v20 source missing: {p}")

server = server_path.read_text(encoding="utf-8")
device = device_path.read_text(encoding="utf-8")
readme = readme_path.read_text(encoding="utf-8")

if "WDTT Plus" not in readme or "GETCONF:" not in server:
    sys.exit("FAIL: upstream appears incompatible")
checks = {
    "device lock only for generated passwords": 'valid && isGenPass && entry.DeviceID != "" && entry.DeviceID != deviceID',
    "reject mismatched device": 'DENIED:device_mismatch',
    "bind first device": 'if isGenPass && entry.DeviceID == "" {',
    "persist device binding": 'entry.DeviceID = deviceID',
    "persist DB transaction": 'if err := saveDB(); err != nil {',
    "separate administrative credential": 'isMainPass := password != "" && password == db.MainPassword',
    "separate client password validation": 'entry, isGenPass := db.Passwords[password]',
}
for name, needle in checks.items():
    if needle not in server:
        sys.exit(f"FAIL: WDTT server device policy changed or absent: {name}")
client_checks = {
    "validate device ID": 'fun valid(value: String)',
    "derive existing/platform/device ID": 'fun resolve(',
}
for name, needle in client_checks.items():
    if needle not in device:
        sys.exit(f"FAIL: WDTT Android identity policy changed or absent: {name}")

print("PASS: WDTT Plus v20 generated client access is first-device-bound in source.")
print("LIMITATION: device_id is not a hardware-signed challenge; no protection")
print("against spoofed device IDs or forwarding before initial activation.")
