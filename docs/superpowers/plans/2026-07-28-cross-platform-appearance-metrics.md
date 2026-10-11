# Cross-platform Appearance and Metrics Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task by task.

**Goal:** Deliver real desktop and Android controls for two visual styles, three color modes, default/professional operation modes, selectable live metrics, and repair Android's completed-transfer routing.

**Architecture:** Keep appearance and metric preferences local to each client so switching them never touches encrypted vault data or the network. Desktop preferences live in a small validated localStorage model and CSS data attributes; live process metrics cross the Electron preload boundary through one fixed, argument-free IPC method. Android preferences use SharedPreferences/AppCompat night mode and a lightweight periodic collector that only runs while the activity is visible and professional mode is enabled.

**Tech Stack:** React 18, TypeScript, Electron 41, next-themes, Tailwind CSS 4, Kotlin, AppCompat/Material Components, Android XML/ViewBinding, Node test runner, JUnit 4.

---

## Task 1: Desktop preference model

**Files:**
- Create: `modules/file_vault/ui/src/lib/appearancePreferences.ts`
- Create: `modules/file_vault/ui/tests/appearancePreferences.test.mjs`

1. Write failing Node tests for invalid stored values, defaults, metric de-duplication, and DOM data-attribute application.
2. Run `npm run test:update` and confirm the new tests fail because the module is missing.
3. Implement typed, validated preferences for visual style, accent, decoration level, and selected metrics.
4. Re-run the tests and confirm they pass.

## Task 2: Desktop settings and visual system

**Files:**
- Create: `modules/file_vault/ui/src/lib/appearanceContext.tsx`
- Create: `modules/file_vault/ui/src/components/AppearanceSettings.tsx`
- Create: `modules/file_vault/ui/src/components/ProfessionalMetricsPanel.tsx`
- Modify: `modules/file_vault/ui/src/main.tsx`
- Modify: `modules/file_vault/ui/src/components/SettingsScreen.tsx`
- Modify: `modules/file_vault/ui/src/index.css`
- Modify: `modules/file_vault/ui/src/i18n/locales/zh/settings.json`
- Modify: `modules/file_vault/ui/src/i18n/locales/en/settings.json`

1. Add a provider that applies validated preferences before first render and persists updates.
2. Add settings controls for system/light/dark, Tessera native/oriental-tech, forest/sky/gold/olive, decoration intensity, and selectable metrics.
3. Add professional-only live metric cards with a pause control and visibility-aware polling.
4. Add low-opacity CSS/SVG-free decorative layers and full light/dark token sets without remote assets or heavy animation.
5. Run TypeScript checking and the Node test suite.

## Task 3: Secure Electron runtime metrics

**Files:**
- Modify: `modules/file_vault/ui/electron/main.ts`
- Modify: `modules/file_vault/ui/electron/preload.ts`
- Modify: `modules/file_vault/ui/src/lib/electronApi.ts`
- Modify: `modules/file_vault/ui/src/shared/ipcTypes.ts`
- Create: `modules/file_vault/ui/tests/runtimeMetricsContract.test.mjs`

1. Write a failing contract test asserting one fixed `system:getRuntimeMetrics` bridge and no renderer-supplied path/command.
2. Implement an argument-free IPC handler using Electron/Node process and OS metrics.
3. Expose only the typed result through preload and the renderer wrapper.
4. Run the contract test, full Node tests, and TypeScript checking.

## Task 4: Android preference model and transfer routing

**Files:**
- Modify: `modules/file_vault/crossdevice/android/app/build.gradle.kts`
- Create: `modules/file_vault/crossdevice/android/app/src/main/java/com/tessera/crossdevice/AppearancePreferences.kt`
- Create: `modules/file_vault/crossdevice/android/app/src/main/java/com/tessera/crossdevice/TransferEventRouter.kt`
- Create: `modules/file_vault/crossdevice/android/app/src/test/java/com/tessera/crossdevice/AppearancePreferencesTest.kt`
- Create: `modules/file_vault/crossdevice/android/app/src/test/java/com/tessera/crossdevice/TransferEventRouterTest.kt`
- Modify: `modules/file_vault/crossdevice/android/app/src/main/java/com/tessera/crossdevice/MainActivity.kt`

1. Add JUnit and failing tests for validated appearance preferences and `recv_done`/transfer event routing.
2. Implement pure preference and routing helpers.
3. Replace the duplicate/unreachable transfer branch in `MainActivity` with the tested router.
4. Run Android unit tests.

## Task 5: Android controls and live metrics

**Files:**
- Create: `modules/file_vault/crossdevice/android/app/src/main/java/com/tessera/crossdevice/AppearanceSettingsDialog.kt`
- Create: `modules/file_vault/crossdevice/android/app/src/main/java/com/tessera/crossdevice/RuntimeMetricsCollector.kt`
- Modify: `modules/file_vault/crossdevice/android/app/src/main/java/com/tessera/crossdevice/MainActivity.kt`
- Modify: `modules/file_vault/crossdevice/android/app/src/main/res/layout/activity_main.xml`
- Modify: `modules/file_vault/crossdevice/android/app/src/main/res/values/strings.xml`
- Create: `modules/file_vault/crossdevice/android/app/src/main/res/values/colors.xml`
- Create: `modules/file_vault/crossdevice/android/app/src/main/res/values-night/colors.xml`

1. Add an appearance button/dialog for interface mode, theme, visual style, accent, decoration, and metric checkboxes.
2. Add a professional diagnostics card using actual app heap, device memory, storage, uptime, and refresh latency.
3. Poll only while visible and professional mode is active; stop callbacks in `onStop`.
4. Apply AppCompat system/light/dark mode and accent/style resources.
5. Run unit tests and assemble a debug APK.

## Task 6: Verification and handoff

**Files:**
- Modify: `task-progress.md`

1. Run desktop Node tests, TypeScript checking, and Vite renderer build.
2. Run Android unit tests and `assembleDebug`.
3. Inspect `git diff --check`, changed-file scope, and security boundary.
4. Record evidence and remaining packaging/device-only checks in `task-progress.md`.
5. Commit only the isolated branch changes with a scoped commit message.
