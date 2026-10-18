# Tessera 0.1.41

The Windows *Devices & sync* page now matches the Android layout: the main features on one screen, each one opening a full-screen panel. *Send clipboard* lets you pick what to send. Clipboard sync is faster on every platform.

## Windows: Devices & sync

- **Everything on one screen.** The page used to stack eleven sections that you had to scroll through. Now the top card holds this device, the online devices, *Send clipboard*, *Send files* with the one/many target picker, and the auto-sync switch. Below it, ten feature tiles fill the rest of the window: Devices, Pair, Clipboard, Transfers, Sync log, Live metrics, Diagnostics, Cross-network, Options and This device. Each tile shows a live summary (online count, nearby devices, firewall state, failures and so on). The column count follows the window shape, and a short last row is stretched, so there are no empty gaps.
- **Full-screen panels.** Clicking a tile opens its panel over the whole page, expanding from the tile you clicked. The panel has only a back button, with no function name in the corner; **Esc** also returns to the tiles. The clipboard timeline, the device list and the pairing tabs each fill their panel.
- **Explanations behind ⓘ.** The descriptions under options, cross-network fields and empty lists now appear on hover instead of taking up the page. Icon-only buttons show their name on hover.

## Send clipboard: single, multiple or all

- On Windows and Android, *Send clipboard* opens a list: the current clipboard first, then the cross-device clipboard timeline. Tick one entry, several, or *Select all*, then send. The selected items go to every connected device one after another, oldest first, so the newest one ends up as the other devices' current clipboard. Sending from this list does not change your own clipboard.
- Automatic sync of newly copied content works as before.

## Faster clipboard sync

- **Windows: no more polling.** The cross-device service listens for the system's clipboard-change notification (`AddClipboardFormatListener`). The app reads the clipboard only when that notification arrives, instead of opening it every 50 ms. Copies are picked up immediately, and other programs' Ctrl+C no longer competes with the app for the clipboard lock. A slow fallback check (once a second) stays in place in case a notification is missed.
- **Android: no fixed delay.** With the Tessera keyboard as the default input method, a copy is read immediately instead of after a fixed 120 ms wait. A second read 80 ms later catches apps that write the clipboard twice.
- **All devices at once.** Clipboard items are now sent to all connected devices in parallel. A device that is busy receiving a large file, or that is reached through the relay, no longer delays the others.

## Also in this release

- The rendezvous server is unchanged apart from the version number. Its binaries are the same as in 0.1.40.

Everything in [0.1.40](release-notes-v0.1.40.md) is included.

This release was built without end-to-end testing. A successful build and signature check do not show that the features work for end users.
