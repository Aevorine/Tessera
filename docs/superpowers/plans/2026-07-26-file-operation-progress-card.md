# File Operation Progress Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `@subagent-driven-development` (recommended) or `@executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-activating, configurable live task card for global Ctrl+V, Delete, and Shift+Delete without harming file-operation speed or reliability.

**Architecture:** The global hook keeps using `hook_agent.exe -> hook_cli.py -> progress_ui.py`, so the card works even when Electron is closed. The file engine publishes lock-consistent snapshots; a native Tk/Win32 card renders them. Electron settings writes an atomic LocalAppData preference file that the independent runtime reads.

**Tech Stack:** Python 3.9, ctypes/Win32, Tkinter, Shell `IFileOperation`, Electron, React/TypeScript, pytest.

---

## File map

- `core/fileops/engine.py`: immutable operation snapshots, streaming progress, fast-move item totals.
- `core/fileops/progress_preferences.py` (new): validated atomic task-card preferences.
- `core/fileops/progress_ui.py`: non-activating card, layout, smoothing, slot allocation and cancellation UI.
- `core/fileops/shell_recycle.py` (new): `IFileOperation` recycle adapter.
- `modules/file_vault/fileops/service.py` and `backend_server.py`: preference RPC boundary.
- `modules/file_vault/ui/src/shared/ipcTypes.ts` and `components/SettingsScreen.tsx`: typed settings UI.
- `modules/file_vault/ui/src/i18n/locales/*/settings.json`: all locale strings.

### Task 1: Engine snapshot contract

**Files:** modify `core/fileops/engine.py`; create `core/fileops/tests/test_progress_snapshot.py`.

- [ ] Write failing tests for immutable snapshots, scanning-to-running transition, byte versus item totals, bounded error summaries, and same-volume move progress.
- [ ] Run `python -m pytest core/fileops/tests/test_progress_snapshot.py -q`; expect failure because snapshots do not exist.
- [ ] Add frozen `TaskProgress` plus one lock-owned `TransferReport.snapshot()` method. Include phase, current path, files/bytes, independent fast-move item totals, elapsed, speed/ETA inputs, cancellation state and at most six errors.
- [ ] Update lazy iterators without a second scan: show `scanning` while totals grow; freeze totals before `running`; update `items_done` after successful `MoveFileExW`.
- [ ] Run `python -m pytest core/fileops/tests/test_progress_snapshot.py modules/file_vault/tests/test_fileops_service_e_series.py -q`; expect PASS.
- [ ] Commit: `feat(fileops): expose consistent operation progress`.

### Task 2: Persist task-card preferences

**Files:** create `core/fileops/progress_preferences.py`, `core/fileops/tests/test_progress_preferences.py`, `modules/file_vault/tests/test_fileops_progress_preferences.py`; modify `modules/file_vault/fileops/service.py`, `modules/file_vault/backend_server.py`.

- [ ] Write failing tests for nine positions, hide values 3/5/10, compact mode, invalid JSON fallback and atomic writes.
- [ ] Run `python -m pytest core/fileops/tests/test_progress_preferences.py modules/file_vault/tests/test_fileops_progress_preferences.py -q`; expect failure.
- [ ] Implement strict preferences at `%LOCALAPPDATA%\Ideal1 File Vault\FileHook\progress_preferences.json`, using temp-file flush plus `os.replace`. Defaults: `bottom-right`, `5`, `false`.
- [ ] Add `file_clip_progress_preferences_get/set` RPCs. Validate enumerations in the backend; do not expose a path to the renderer.
- [ ] Add a provisioned-runtime regression: provision a temporary versioned runtime, save a non-default preference, invoke the copied runtime's preference reader in a separate Python process, and assert it reads the same position/hide/compact values without the Electron backend present.
- [ ] Run the two new suites plus `modules/file_vault/tests/test_fileops_rpc.py -q`; expect PASS.
- [ ] Commit: `feat(file-vault): persist task card preferences`.

### Task 3: Non-activating card and accurate display

**Files:** modify `core/fileops/progress_ui.py`, `core/fileops/hook_cli.py`; create `core/fileops/tests/test_progress_ui.py`.

- [ ] Write failing pure-function tests for nine-grid coordinates, compact/full text, two-second speed smoothing, ETA after one second with frozen totals, four card slots, and a partial-failure final state that exposes the first error plus a bounded “查看详情” list.
- [ ] Write mocked Win32 tests requiring this first-show call order: `withdraw -> obtain HWND -> add WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW -> subclass WM_MOUSEACTIVATE to MA_NOACTIVATE -> SetWindowPos(SWP_NOACTIVATE|SWP_SHOWWINDOW)`. Assert Tk `deiconify()` is never used.
- [ ] Run `python -m pytest core/fileops/tests/test_progress_ui.py -q`; expect failure.
- [ ] Replace the present focus-taking Tk popup with a non-daemon worker plus a withdrawn native card. UI errors must be logged and then wait for the worker result; they must never end an active operation.
- [ ] Read preferences once per task. Use the trigger monitor's work area and safe margins. Stack up to four concurrent cards using named mutex slots; fifth and later tasks still run but create no card.
- [ ] Display indeterminate scanning until totals freeze. Long successful operations auto-hide; fast successful operations below 300 ms create no GUI; errors/cancellations stay visible. The complete state must schedule exactly the selected 3/5/10-second delay; partial failure must display the first error and a button/dialog containing the bounded error list.
- [ ] Run `python -m pytest core/fileops/tests/test_progress_ui.py core/fileops/tests/test_progress_snapshot.py -q`; expect PASS.
- [ ] Commit: `feat(fileops): show non-activating progress cards`.

### Task 4: Recycle-bin progress and cancellation

**Files:** create `core/fileops/shell_recycle.py`, `core/fileops/tests/test_shell_recycle.py`; modify `core/fileops/engine.py`, `core/fileops/progress_ui.py`.

- [ ] Write failing mocked COM tests: progress sink updates per-item snapshots; `GetAnyOperationsAborted()` is reflected after completion; unavailable COM returns an explicit indeterminate/no-cancel fallback.
- [ ] Run `python -m pytest core/fileops/tests/test_shell_recycle.py -q`; expect failure.
- [ ] Implement worker-thread COM initialization, `IFileOperationProgressSink` callbacks, recycle flags and `GetAnyOperationsAborted()` handling. `IFileOperation` exposes no `Abort()` method, so recycle remains non-cancellable. Record only completed callbacks as completed; an observed abort never claims rollback.
- [ ] Integrate it for `delete_items(recycle=True)`. Keep `SHFileOperation` only as the honest fallback: elapsed time and “system processing”, no ETA and disabled cancel.
- [ ] Run the shell, card and E-series tests; expect PASS.
- [ ] Commit: `feat(fileops): report recycle delete progress`.

### Task 5: Electron settings

**Files:** modify `modules/file_vault/ui/src/shared/ipcTypes.ts`, `modules/file_vault/ui/src/components/SettingsScreen.tsx`, and every `modules/file_vault/ui/src/i18n/locales/*/settings.json`; create `modules/file_vault/tests/test_i18n_settings_keys.py` if no equivalent key-parity test exists.

- [ ] Write failing locale/type tests for the task-card preference type and all new keys.
- [ ] Run `python -m pytest modules/file_vault/tests/test_i18n_settings_keys.py -q` and, from `modules/file_vault/ui`, `npm exec -- tsc --noEmit`; expect failure.
- [ ] Add `TaskCardPreferencesSetting` below `FileHookAutoStartSetting`: accessible nine-grid radios, immediate static preview, 3/5/10 select, compact checkbox, RPC load/save and rollback on error.
- [ ] Add matching translations in zh/en/es/fr/ru/ar; do not change keyboard bindings.
- [ ] Re-run the locale test and, from `modules/file_vault/ui`, `npm exec -- tsc --noEmit`; expect PASS.
- [ ] Commit: `feat(file-vault): configure task card display`.

### Task 6: Build and Windows acceptance

**Files:** modify only defects found above.

- [ ] Run targeted regression suite: `core/fileops/tests/test_progress_snapshot.py`, `test_progress_preferences.py`, `test_progress_ui.py`, `test_shell_recycle.py`, and relevant `modules/file_vault/tests/test_fileops_*.py`.
- [ ] From `modules/file_vault/ui`, run `npm exec -- tsc --noEmit` and `npm run lint`; report unrelated lint failures without suppressing them.
- [ ] From `modules/file_vault/ui`, build the original portable path with `npm run build`; verify `release/0.1.0/Ideal1 File Vault-Windows-0.1.0.exe` and packed `resources/python/core/fileops` contain changed files.
- [ ] After foreground permission, perform disposable-data acceptance: large paste shows bytes/speed/elapsed/ETA; small-file tree scans then becomes determinate; Delete and Shift+Delete retain distinct semantics; every grid position works; compact mode works; each 3/5/10-second hide duration is timed; a partial failure shows its first error and details; foreground HWND is unchanged on first card show.
- [ ] Fully close Electron, leave only the provisioned `%LOCALAPPDATA%` hook runtime running, then trigger a disposable operation and verify it uses the saved non-default card position/hide/compact preference.
- [ ] Commit only intended files with `feat(file-vault): add real-time file operation cards`. Publish only after explicit user authorization.
