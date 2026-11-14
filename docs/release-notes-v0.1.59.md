# Tessera 0.1.59

## Devices & sync: phones stay connected to the PC

**What was wrong:** syncing between a PC and a tablet worked, but a phone dropped off for hours at a time and only came back when someone opened Tessera on it. On the affected PC, the phone was unreachable from 12:20 to 17:00 on one day and reconnected the moment the app was opened. There were two separate causes.

**1. Android 15 stopped the phone's sync service after six hours.** The Android app ran its background sync as a "data sync" foreground service. On Android 15 such a service may run for only six hours a day in the background. When the limit is reached the system stops it and refuses to start it again until the app is opened. Older Android versions, as on the tablet, have no such limit, which is why only the phone was affected.

- The sync service now runs as a **"connected device"** foreground service: a link kept open to a paired computer. This type has no daily limit.
- If the system still refuses to start the service in the background, Tessera no longer crashes and retries in a loop. It records the stop and starts again the next time you open the app.
- **Settings › System permissions & background running** shows when the system last stopped background sync. A new button opens the phone's auto-start and background-activity page (Honor, Huawei, Xiaomi, OPPO, vivo; other phones get the app info page). Honor and Huawei phones need "Manage manually → Allow background activity" there.
- After the system has stopped sync, the next time you open the app a short message says so, once per stop.

**2. A VPN or proxy on the PC made old phone addresses look reachable.** The PC remembers the addresses a phone has used on other networks (a hotspot, mobile data). With a proxy or VPN in TUN mode (sing-box, Clash, WireGuard and similar), the proxy accepts any TCP connection to an address outside the local network immediately. Measured on the affected PC: 1–13 ms, even for an address that does not exist. Tessera then waited 13 seconds for a handshake that could never finish. Every 5 minutes the device showed "authenticating → offline", and the failure also turned off the fast TCP path to that phone for 5 minutes.

- The fast TCP path is now tried only on addresses inside the PC's own network adapters (no VPN or proxy adapters), plus loopback and link-local. Other remembered addresses still get the QUIC path, whose encrypted handshake a proxy cannot fake.
- TCP failures are now remembered per address, not per device, so one stale address no longer slows down the phone's real address.

## The PC says why a phone is offline

If a phone that was connected earlier stops answering on the address it last used on the local network, the device's details now say: **the phone isn't answering, Tessera was most likely paused in the background by the system; open Tessera on the phone once to reconnect, and allow background activity on the phone to stop it happening.** Before, this showed as "not on the same network", which pointed the wrong way. Two PCs still show the plain reason.

## Notes

- **Update the phone and tablet to 0.1.59 from inside the app.** The Android change only takes effect on the phone itself. The PC fix works with any phone version.
- Not tested on a real phone or tablet (no device was connected). The Android change was checked in the built APK: service type "connected device", signed with the release key. The PC changes were tested end to end with simulated devices. Before the fix, a stale address reproduced exactly the "authenticating → offline" sequence from the affected PC's log.
- This release was packaged without running the full test suite. The tests for the sync core pass.
