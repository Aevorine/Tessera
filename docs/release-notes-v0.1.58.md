# Tessera 0.1.58

## Devices & sync: the link to a phone no longer drops every few minutes

**What was wrong:** with the phone's screen off, Android suspends the CPU and lets the Wi-Fi radio skip beacons. The app then answers a second or more late, but the connection itself is fine. The PC treated two unanswered pings (1.4 seconds) as a dead link and closed it. Reconnecting took 6 to 13 seconds. On the affected PC the log shows 192 such timeouts in three days, every one of them exactly 1.4 seconds after a 5-second heartbeat tick. Anything copied during a reconnect was not synced until the link came back, which looked like "the devices don't sync".

**What changed:**

- **A phone gets patience, a PC does not.** When the other side is a phone or tablet, an idle link is closed only after 20 seconds without a single byte from it. Tessera keeps probing during that time, and each probe also helps wake the phone. Between two PCs a dead link is still found in about 3.4 seconds.
- **Clipboard content sent while the phone is asleep arrives when it wakes**, on the same connection. Test: phone frozen for 3 seconds, text copied on the PC halfway through, delivered 1.5 seconds later, no reconnect.
- **Probe timeouts follow the measured link.** They now use a smoothed round-trip time and its variation (the RFC 6298 formula) instead of the last single sample.
- **"Poor link" appears only after 4 seconds of silence** from a phone, not on every late answer.
- **No more "connecting → offline" flicker for a device that is away.** After three failed background attempts, further retries are silent. The affected PC logged about 3,200 such flips per day. The state changes again as soon as a connection attempt actually reaches the device.
- **"Last seen" is correct for devices that connect to the PC.** It used to update only when the PC dialled out, so phones showed a date weeks old.
- **Android keeps Wi-Fi in low-latency mode while the app is on screen**, and releases it when you leave the app. Not measured on a phone.

**Speed:** on one PC over loopback, 200 clipboard texts took a median of under 0.5 ms and at most 1.5 ms from "copied" to "delivered" (encryption, framing and duplicate check included). Real Wi-Fi adds the network's round trip.

## Lower CPU use when idle

Measured on the affected PC with the window idle:

- **Sync service: about 5.5 % of one core → near zero.** It checked for network changes every 2 seconds, and Go's standard library asked Windows for the full adapter table once per adapter (21 calls with 20 adapters; one read of the table takes roughly 18 ms on that PC). Tessera now reads the table in one call, caches it, and lets Windows report address and interface changes. In a 40-second profile the CPU samples fell from 22.7 s to 0.14 s.
- **Backend: about 10 % of one core → 0.16 %.** The helper that remembers the last foreground window (for click-to-paste) listed every process on the system every 150 ms. It now does that only when the foreground window changes.
- **Database files stop growing.** The write-ahead log of each database is cut back to 4 MB after a checkpoint. On the affected PC the clipboard database's log had stayed at 52 MB.

## Devices & sync home: three categories

The ten tiles are grouped into **Devices** (devices, pairing, this device), **Sync & transfers** (clipboard, sync log, transfers, options) and **Connection** (live metrics, diagnostics, cross-network). On short windows such as 1280×720 the tiles switch to a compact row so all three groups fit on one screen.

## Log

A new `clip_push` entry records how long each automatic clipboard sync took from the system's change notice to "sent", how many devices it reached, and why it was skipped. It never contains the content. `link_down` entries now say whether the other side is a phone.

## Notes

- Not tested on a real phone or tablet (no device was connected): the patient link handling was verified with two simulated devices, one of them frozen.
- Both sides need 0.1.58 for the full effect. A PC on 0.1.58 already stops dropping the link to an older phone.
- This release was packaged without running the full test suite. The sync core's tests for the changed packages pass.
