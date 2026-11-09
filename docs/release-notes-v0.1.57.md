# Tessera 0.1.57

## Android: the device name no longer turns into "正在启动同步服务…"

**What was wrong:** the title line on the home screen showed both the device name and the "starting sync service…" status. When a request was queued before the background service was ready, the status text replaced the name. Reopening the app while the service was still running never brought the name back. The service had already announced itself, and the app ignored the name in its status reply. Tapping **Rename** then pre-filled the status text as if it were the name. Confirming it really renamed the device to "正在启动同步服务…".

**What changed:**

- The name and the status are kept apart. The name comes from the status reply too, so it is back right after reopening.
- The last known name is cached and shown immediately when the app opens.
- The rename box pre-fills only the real name. If the name is unknown, the box is empty and the hint shows the phone model. Status texts are never accepted as a name.
- A device that was renamed to the status text by this bug is renamed back to its phone model automatically, once. You can rename it again at any time.

## Faster transfers between phone, tablet and PC

- **Android keeps Wi-Fi and the CPU at full speed while bytes are moving.** Android's Wi-Fi power saving wakes the radio only every 100–300 ms when the screen is off or the app is in the background, which cut throughput to a few hundred KB/s. During a transfer Tessera now holds a low-latency Wi-Fi lock (high-performance on Android 9 and earlier) and a partial wake lock. Both are released 15 seconds after the last progress event, so they do not drain the battery when idle.
- **Receiving no longer stalls the network while writing to disk.** Each incoming chunk was hashed and written on the same loop that reads the network, so the connection sat idle during every disk write. Chunks now go to a per-transfer writer through a short queue (4 chunks, at most 16 MiB). The final check waits until every queued chunk is on disk. Integrity checks, resume records and the protocol are unchanged, so older versions still interoperate.
- **Sending starts sooner.** Before the first byte goes out, the sender hashes the whole file. It now reads and hashes up to four chunks in parallel. The result is byte-for-byte identical to before.
- Measured on one PC over loopback (200 MiB file, three runs each): **130–197 MB/s before, 306–315 MB/s after.** Real Wi-Fi speeds depend on the network. The Android Wi-Fi lock gain was not measured on a phone.

## Android: face unlock on Honor and Huawei phones and tablets

**What was wrong:** Honor and Huawei face unlock is not registered with Android's standard biometric prompt. The phone unlocks with your face, but apps that ask Android for biometrics only get fingerprint. Tessera's "face or fingerprint" button therefore only ever showed a fingerprint prompt.

**What changed:**

- On Honor and Huawei devices, Tessera now talks to the phone's own face service, the same face you enrolled in system settings. The comparison runs inside the system; Tessera only receives "match" or "no match" and never sees face data.
- The lock screen tries face first, with a round live preview, a progress ring and live hints such as "move closer", "too dark" or "open your eyes". If it fails, fingerprint, app password and screen-lock PIN remain available.
- If the device has no vendor face service, no enrolled face, or does not allow apps to use it, the face option is simply not shown. Nothing changes there.
- The first time, Tessera may ask for camera permission. No network access, nothing runs in the background.

## Developer tests no longer trigger a Windows firewall prompt

Running the core's tests used to make Windows ask whether `agent.test.exe` may access the network. That program is the end-to-end transfer test (two simulated devices sending files to each other), and it is still used. It had been opening a LAN discovery port on all interfaces even though the test devices only listen on 127.0.0.1. Loopback-only nodes no longer announce themselves on the LAN, and a node whose port is taken now retries on the same loopback address instead of switching to all interfaces. This also stops test devices from briefly appearing under "Nearby devices" on real phones.

## Windows: simple mode is gone

The app always shows the full interface. The simple/professional switch and both icons have been removed from the sidebar, the command palette and Settings › Appearance. To see less, close what you don't need (next section).

## Close anything, reorder the sidebar, on every device

**Windows**

- **Drag sidebar entries up and down.** This works in the expanded and the collapsed sidebar. You can also drag by the grip, or with the keyboard: Tab to the grip, Space to pick up, arrow keys to move, Space to drop. The order is remembered.
- **Close sidebar entries** with the × that appears on hover. A closed entry still opens with Ctrl+K. Settings cannot be closed, because that is where you restore things.
- **Close any block on any page.** Click **Edit layout** at the bottom of the sidebar. Every card, section and button group gets a ×. Click the × on what you don't want, then press **Done** or Esc. Sections with a title also show a × on hover outside edit mode.
- **Restore** in Settings › Appearance › **Closed content**: restore one item, restore all, or reset the sidebar order.

**Android phones and tablets**

- **Drag feature tiles.** Long-press a tile and drop it on another tile to move it there. Long-press and release without moving to get a menu: close this tile, move to front, move to back, reset the order, edit layout, closed content.
- **Edit layout** (on the **This device** panel, or from any tile's menu) puts a × on every card and button. Closed content stays hidden even when the app would normally show it again, for example the transfer progress card.
- Long-press the home-screen buttons (Scan, My code, Send clipboard, Send files, Rename) to close them directly.
- **Closed content** (on the **This device** panel) lists everything you closed, with restore selected and restore all.
- The **This device** tile and the customize buttons cannot be closed, so you can always get things back.

## Notes

- Not tested on a real Android device (none was connected): the name fix, the Wi-Fi lock, the tile drag and vendor face unlock were compiled but not run on a phone. Vendor face uses a private system interface; some Honor/Huawei versions may refuse third-party apps, in which case the option stays hidden.
- On Windows, a closed block is identified by its title, so it reappears if you switch the interface language.
