# Tessera 0.1.56

## Windows: unlock now starts with face or fingerprint, and only shows what this PC can do

**What was wrong:** the login screen could open on the password tab even on a PC with a working, enrolled fingerprint sensor. The screen first used the last saved sensor check. If that check had failed once (for example while the backend was restarting), the screen treated it as "no biometrics", switched to password, and never switched back when the real answer arrived. A Windows Hello prompt that opened behind other windows also timed out after 25 seconds and fell back to password.

**What changed:**

- The unlock order is now **face → fingerprint → iris → password → authenticator → email code → recovery key**.
- Methods that this device or vault cannot use are hidden. A PC without a face camera shows no face tab. A vault without an authenticator or e-mail sign-in shows no tab for it. Without Windows Hello the screen starts on password.
- A failed sensor check is no longer saved as "no biometrics". It is retried, and when the real answer arrives the screen switches back to biometrics unless you picked a tab yourself.
- Tessera brings its window to the front before it asks Windows Hello, so the prompt opens on top.
- The login page and the re-verification dialog share one component, so they always behave the same.
- Every unlock attempt is logged (`unlock_attempt`: method, result, error code, duration). Nothing you type is logged.

## Android: "verify when opening the app" now really works

**What was wrong:** the check ran only when the app was created. The background sync service keeps the app alive, so opening it again from the home screen, recent apps or a notification skipped the check. The app content was also visible behind the prompt.

**What changed:**

- A lock screen now covers the app every time you return to it from the background. The app content stays hidden until you pass the check. Screen rotation and pages the app opens itself (file picker, QR scanner, system settings) do not lock it again.
- Order: **face or fingerprint (named after this device's hardware) → app password → screen-lock PIN**. Methods the device does not support are hidden, also in Settings.
- Cancelling no longer closes the app. You stay on the lock screen and can retry or use another method. Back sends the app to the background.
- After five wrong app passwords, input is blocked for 30 seconds, doubling up to 15 minutes.
- On Android 13 and later the recent-apps thumbnail is hidden while a lock is set.

## Notes

- Windows Hello and Android BiometricPrompt choose the sensor themselves. Separate face and fingerprint tabs only set the order and labels. Some phone makers keep face unlock for the lock screen only; then only fingerprint is offered.
