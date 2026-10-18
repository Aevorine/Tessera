# Tessera 0.1.38

Android phone and tablet release: the home screen becomes one page with the main functions on it, and every secondary function opens as a full-screen panel.

## Android: one home screen, full-screen panels

- **Home screen.** A status header shows the device name, how many paired devices are online, the best link latency and an online indicator that pulses when the count changes. The four main actions (scan, my code, send clipboard, send files) and the one-device / several-devices choice sit in the same card. Active transfers and paired devices follow.
- **All features grid.** Pairing, Clipboard, Cross-network, This device, Updates, Security and (in professional mode) Diagnostics each have a tile with a live summary: nearby devices, auto-sync and timeline count, cross-network on or off, signing status, available update, lock mode or the number of system settings that need attention.
- **Full-screen panels.** Tapping a tile expands its panel from the tile; Back, Esc or the arrow closes it. The panel that was open survives rotation and theme changes. All existing controls moved into these panels unchanged; cross-network, updates, app lock and the diagnostic log are no longer collapsible because each now has a panel of its own.
- **Tablets.** On a tablet in portrait the content is limited to a 720 dp column. At 840 dp and wider (landscape tablets, unfolded foldables) the home screen splits into two columns: status and devices on the left, the features grid on the right. The grid uses three to six columns depending on width.
- **Speed.** The first frame lays out only the home screen; panels are measured when opened. The clipboard timeline inside its panel and the live metrics are rendered only while their panel is open. The pairing QR code is generated from a pixel array in one call instead of 313,600 single-pixel writes.
- **Fixes.** Generating a six-digit pairing code no longer also draws it as a QR code under "My pairing code". Snackbars are raised above the full-screen layers so they stay visible. On Android 15 and later, where edge-to-edge is enforced, the toolbar and panels keep clear of the status and navigation bars.

## Also in this release

- Windows, the rendezvous server and the cross-device protocol are unchanged apart from the version number.

Everything in [0.1.37](release-notes-v0.1.37.md) is included: switchable update source (main repository or mirror) for Windows and Android.

This release was built without running tests; successful compilation and signature checks are not end-user functional validation.
