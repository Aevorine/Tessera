# Tessera 0.1.47

## Faster local search

- Passwords: pinyin, account/site/URL/note queries and highlighted results; existing health metrics remain selectable.
- Recovery codes: search service/account/source file/note; extra ordering by relevance, oldest change or remaining stock.
- Clipboard history: field queries, time ranges and frequency ordering; existing hidden-item unlock and pin-order boundaries remain in place.
- Devices and sync: online/type filters and latency ordering on Windows; background search and direct file/copy actions on Android phones and tablets.
- Compact full-width workspaces retain the shared font, color and icon-tooltip system. Search queries stay in page-session memory.

## Downloads

`Tessera.exe` is the Windows portable application. `Tessera.Setup.exe` is the Windows installer. The APK is the Android phone/tablet application. Rendezvous archives are optional servers for cross-network discovery/relay. `SHA256SUMS.txt` covers all six downloadable binaries/archives.

Windows applications and the Windows rendezvous executable use the existing pinned publisher key. The Android APK uses the existing application signing key. No vault data, signing keys or machine-local configuration is included.

## Delivery boundary

Compilation, source/history secret scans, executable signatures and uploaded asset digests are publication checks. Automated tests, GUI interaction checks, physical device synchronization and performance benchmarks were not run. Android received-file search retains the existing 500-file inventory bound; clipboard search covers available previews. See [search behavior and limits](https://github.com/Aevorine/Tessera/blob/main/docs/search-workspace.md).

Changes: #30. Official design references and data attribution are listed in the search documentation. Source license: AGPL-3.0-only OR LicenseRef-Ideal1-Commercial.

