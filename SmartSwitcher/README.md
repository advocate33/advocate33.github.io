# SmartSwitcher 0.1.0 — Windows 11 prototype

Prototype of a local Russian/English keyboard-layout correction utility.
**Not a finished Caramba Switcher Pro replacement.**

## Implemented
- Manual text correction using a small, explicit Russian/English whitelist.
- Optional experimental automatic correction after Space **only in Windows Notepad**.
- Optional Ctrl+Alt+F12 disables the hook; Ctrl+Alt+Z reverts the most recent correction.
- Local text processing only. No network calls or saved keystroke logs.
- One instance per Windows user; tray icon.

## Safety limits
- Auto-correction OFF on startup. Enable only after explicit warning.
- Do not use with unsaved important documents.
- Keyboard layout detection and simulated input have not yet been validated on all Windows versions.
- Do not use on elevated windows, RDP sessions, password prompts, or sensitive forms.
- The experimental keystroke hook can lose or misplace text; initial testing should use disposable Notepad text.

## GitHub Actions build
This project lives only on the dedicated `smartswitcher-actions` branch,
under `SmartSwitcher/`. The workflow is in repository-root
`.github/workflows/smartswitcher-windows.yml`, as required by GitHub Actions.

Go to **Actions → SmartSwitcher Windows x64 → latest run → Artifacts**,
download `SmartSwitcher-win-x64-v0.1.0`, unzip, run `SmartSwitcher.exe`.

Alternatively, from SmartSwitcher directory, with .NET 10 SDK installed:
``powershell
.\Build-Windows.ps1
``
The ZIP will be in `out/`.

## Next milestones
1. Validate the app on actual Windows 11 hardware.
2. Expand and benchmark deterministic correction and exception rules.
3. Legal dictionary, snippets, cursor layout indicator.
4. Offline dictation, opt-in browser handoff to ChatGPT, encrypted settings synchronization.

No modifications to the CRM main branch, CRM files, or deployment pipeline.
