# Tessera 0.1.39

Android phone and tablet release: the home screen fills the whole display, panels lose their title bars, the update panel links to GitHub, and every text is set in a bundled Song / Times New Roman serif.

## Android: home screen and panels

- **No app title on the home screen.** The top bar that showed "Tessera 跨设备" is gone; the status header (device name, devices online, latency, the four main actions) is now the first thing on screen.
- **Content fills the screen.** The feature tiles stretch to take all the height left between the status header and the paired devices, so there is no empty band at the bottom. The column count is picked from the space available so tiles stay close to square, and an incomplete last row widens its tiles to the full row. Tablets and phones use the full width in every orientation; landscape tablets and unfolded foldables split into two columns (status and devices on the left, tiles on the right) with both columns running to the bottom of the screen.
- **Panels without titles.** A full-screen panel shows only a back button at the top — the name of the function you just tapped is no longer repeated. Screen readers still announce the panel name. Cards that only restated the panel name (cross-network, updates) lost that header too. On wide screens a panel lays its cards out in two columns.
- **Less explanatory text.** The cross-network explanation, the address and passphrase helper lines and the vendor launch-manager instructions moved behind an ⓘ button next to the relevant control; the address field shows `example.com:47820` as a placeholder instead.
- **Names on hover.** Icon-only buttons, the feature tiles, the four main actions and the transfer pause / cancel buttons show their names on mouse hover (tablets with a mouse or trackpad) and on long-press.

## Android: update panel links to GitHub

- The update panel shows the GitHub releases page of the selected source — `github.com/Aevorine/Tessera/releases`, or `github.com/Aevorine/Tessera-releases/releases` when the mirror switch is on — and switches to the new release's own page once a newer version is found. Tap to open it in the browser, long-press to copy it. The "new version" dialog has a GitHub button for the same page.

## Android: typeface

- The app bundles **Tessera Serif**, a merge of [Tinos](https://github.com/googlefonts/tinos) (metric-compatible with Times New Roman) for Latin letters, digits and punctuation and [Noto Serif SC](https://github.com/notofonts/noto-cjk) (Song style) for Chinese, in regular and bold (about 3.2 MB each, stored uncompressed so the system maps it directly). Previously the app asked for the system `serif` family, which on many Chinese-market phones has no Song-style Chinese and fell back to sans-serif. Body text stays at 16 sp (小四) and section titles at 19 sp (四号). Both fonts are under the SIL Open Font License 1.1; the licence texts ship in the APK under `assets/licenses/`, and the merge script is `modules/file_vault/crossdevice/android/tools/fonts/build_fonts.py`.
- Fix: in dark mode the theme lost its typography overrides and every text fell back to the system sans-serif. Light and dark now share one base theme.
- Pairing codes, addresses and the device fingerprint use the same typeface instead of monospace (Tinos digits are fixed-width, so codes still line up). Only the professional-mode metrics table stays monospace.

## Also in this release

- Windows, the rendezvous server and the cross-device protocol are unchanged apart from the version number.

Everything in [0.1.38](release-notes-v0.1.38.md) is included: one-screen Android home with full-screen feature panels.

This release was built without running tests; successful compilation and signature checks are not end-user functional validation.
