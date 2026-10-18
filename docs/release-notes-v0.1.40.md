# Tessera 0.1.40

Android fix release: the pairing-code countdown now counts down.

## Android: pairing codes

- **The countdown was frozen.** "My pairing code" showed "299 秒后过期" and never changed: the remaining time was computed once, when the code arrived, and never again, while the code itself kept expiring after five minutes. The label now updates on every whole second as `m:ss 后过期` (for example `4:59 后过期`), rendered only at the moment the displayed second changes rather than by a fixed one-second poll.
- **Expired codes are replaced.** When the code runs out while the pairing panel is open, the app asks for a fresh one straight away and shows "正在换新码…" in the meantime, so the code on screen is always one that still works. With the panel closed or the app in the background the countdown stops; reopening the panel either resumes it or, if the code expired meanwhile, fetches a new one.
- **Six-digit code dialog.** The same frozen label and the same fix apply to the six-digit code: the dialog counts down and renews the code on expiry while it is open; closing it stops the timer and withdraws the code as before.
- **Code put away after pairing.** Once a pairing completes, "My pairing code" is hidden and no further code is issued, matching what the README already described.

## Also in this release

- Windows, the rendezvous server and the cross-device protocol are unchanged apart from the version number.

Everything in [0.1.39](release-notes-v0.1.39.md) is included: Android home that fills the screen, panels without titles, GitHub link in the update panel, bundled Song / Times New Roman serif.

This release was built without running tests; successful compilation and signature checks are not end-user functional validation.
