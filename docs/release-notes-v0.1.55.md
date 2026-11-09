# Tessera 0.1.55

## Files sent to a phone or tablet now actually land where you can see them

**What was wrong:** when Tessera on Android was running in the background, a received file stayed inside the app's private storage. Only the open app screen moved files into your chosen folder. The sender still showed "Direct", and every later send of the same file showed "Already there", because the phone's hidden copy matched. Neither device had made the file visible.

**What changed:**

- The background sync service now saves every received file to its final location before it tells the sender "done". It writes the file, reads it back, checks its SHA-256, and only then removes the staged copy. If saving fails, the sender sees an error and the phone keeps the complete original.
- With no receive folder chosen, Android 10 and later save to the public **Download/Tessera** folder, which any file manager can see. Android 8–9 keep the previous in-app folder.
- On first start after the update, files that earlier versions left inside the app are delivered automatically.
- "Already there" now also delivers the existing copy and points to it, and it never makes a duplicate.
- The phone shows a **"File received from &lt;device&gt;"** notification. Tap it to open the file.
- On Windows, a system notification appears when a file arrives while the window is hidden or in the background. Click it to show the file in Explorer.

## The sender knows whether the file was saved

- Each finished send in the activity list carries a badge. **Saved by receiver** means the receiving device confirmed the final save; hover over it to see the location. **Legacy receipt** means the receiving device runs an older version that cannot confirm. Update that device.
- The unified log now records `delivery_confirmed`, `skipped` and the kind of save location for every transfer. It records no file names or paths. Claude Code can query it with `applog_query`.

## Compatibility

- The protocol additions are optional fields, so 0.1.55 still talks to older versions. Files reach a phone in the background only when the **receiving** device runs 0.1.55.
