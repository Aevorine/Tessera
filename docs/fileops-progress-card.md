# File operation task card acceptance

The native card uses `WS_EX_NOACTIVATE`, `WM_MOUSEACTIVATE = MA_NOACTIVATE`,
and `SWP_NOACTIVATE` so a FileHook operation should not steal focus from the
triggering application. Automated tests cover the Win32 call ordering and
lifecycle. Manual no-focus acceptance on a real desktop remains pending Task 6.

Until Task 4 adds an `IFileOperation` recycle adapter, recycle operations are
shown as indeterminate system work and do not offer cancellation.
