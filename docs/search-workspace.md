# Local search workspace

Version: 0.1.47. Source review: 2026-10-19.

## Query behavior

Space-separated terms must all match. Use `"exact phrase"`, `-excluded`, or a field prefix such as `username:alice`, `service:example`, `app:browser`, `device:tablet`. Field buttons insert the appropriate prefix. Chinese field aliases, full-width input and pinyin are supported. Desktop pinyin includes alternate readings; Android currently uses the first table reading per character. Typos and skipped letters are tried only after the strict pass yields no results. Approximate desktop results display an approximation badge.

Search terms are held in component memory and released on unmount. Password values and recovery-code values never enter search indexes. Clipboard content and notes can contain sensitive information; search remains local and follows the existing unlock and hidden-item boundaries. Clearing search restores each page's established ordering and filters. Clipboard pin ordering stays available only for the unfiltered manual-order view.

## Modules and resource use

`lib/search` owns query parsing, cached field normalization, scoring and deferred desktop queries. `lib/search/fields` defines each feature's searchable metadata. `components/search` owns input and highlights. Existing virtualized password, recovery and clipboard lists remain in place; deferred React rendering keeps the input update separate from result rendering but does not move CPU work into a worker.

Android `HomeSearch` owns query routing, a single background executor and one replaceable pending task. Generation numbers discard outdated results. RecyclerView adapters retain stable-item diffing. File metadata enumeration runs off the UI thread; queries use its session cache, invalidated when a transfer leaves the active list. Received-folder inventory retains the existing 500-file bound; externally added files require reopening the screen to refresh that cache. Timeline search covers previews, not unavailable remote bodies. Search terms are not persisted on Android either.

## Interface

Shared workbench pages use the existing Times New Roman / Song font stack and compact full-width spacing. Page names remain screen-reader headings without a repeated visible title. Existing global icon tooltips and labels are retained. No new UI framework or runtime dependency was installed.

## Source references

- [Bitwarden vault filters](https://bitwarden.com/help/filter-your-vault/): scope selectors and feature-specific filters.
- [1Password recovery codes](https://support.1password.com/recovery-codes/): recovery codes are credentials; keep them outside general metadata indexing.
- [Android canonical layouts](https://developer.android.com/develop/ui/views/layout/canonical-layouts): list-detail layouts for changing window widths.
- [Unicode License V3](https://www.unicode.org/license.txt): attribution for the derived pinyin tables.

These are independent owners supporting their respective documented behaviors, not evidence of Tessera's measured runtime performance. No automated tests, GUI interaction checks or performance benchmarks were run for this release. Build/signature/digest checks are publication gates, not evidence of device-to-device runtime behavior.
