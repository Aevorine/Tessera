# Tessera 0.1.60

## Click to paste no longer gives up while another program reads the clipboard

**What was wrong:** the Windows clipboard can be open in only one program at a time. Screenshot tools, clipboard managers, download managers (watching for copied links), remote desktop and input methods all open it for a moment whenever something is copied. When you clicked an entry in the clipboard history, Tessera gave up after about half a second if another program still held the clipboard. You saw "Paste failed", and the diagnostic report only said "clipboard_paste call failed" with no reason. The affected PC logged 8 such failures in two days.

**What changed:**

- **Tessera waits up to 1.5 seconds** for the clipboard when you paste, retrying quickly at first and then every 0.2 seconds. Background reading of the clipboard keeps its short wait.
- **If it is still blocked, the message names the program**, for example: "The clipboard is in use by PixPin.exe and wasn't released within 1.5 seconds. Click again in a moment; if this happens often, turn off clipboard monitoring in PixPin.exe."
- **The diagnostic report records the reason:** which program held the clipboard, or that an image could not be prepared. The log also gets one line with the Windows error code. Clipboard contents are never recorded.

**Test:** another process held the clipboard open for 0.8 seconds. 0.1.59 failed after 0.50 seconds; 0.1.60 pasted after 0.98 seconds. With a 2.5-second hold, 0.1.60 reported the holding program after 1.38 seconds.

## Notes

- No Android or sync changes beyond 0.1.59; the Android app is rebuilt only to keep version numbers aligned.
- This release was packaged without running the full test suite.
