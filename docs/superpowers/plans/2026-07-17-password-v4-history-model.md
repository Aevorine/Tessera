# Password v4 M1 History Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an encrypted, bounded five-snapshot history to each password entry while safely loading legacy version 1 vaults and preventing accidental history loss or exposure.

**Architecture:** Keep one current `PasswordEntry` per stored row and embed immutable `PasswordHistorySnapshot` objects in it. Separate persisted serialization (includes history) from RPC serialization (redacts history), validate every untrusted JSON boundary explicitly, and only rewrite the encrypted vault when persisted state actually changes.

**Tech Stack:** Python 3.9, dataclasses, JSON, AES-GCM through the existing `modules.file_vault.crypto`, pytest, existing JSON-RPC backend.

---

## File map

- Modify `modules/file_vault/passwords.py`: history data classes, strict v1/v2 parsing, persistence validation/serialization, no-op update semantics, history-aware dedupe.
- Modify `modules/file_vault/backend_server.py`: redacted RPC serialization, exact add/update request validation, and no-write behavior for unchanged operations.
- Modify `modules/file_vault/tests/test_passwords.py`: model, migration, schema matrix, downgrade, export and dedupe tests.
- Modify `modules/file_vault/tests/test_backend_server.py`: RPC request/response boundaries and no-op write tests.
- Modify `task-progress.md`: record M1 evidence only after verification.
- Do not modify or stage `modules/file_vault/data/passwords.vault*` or existing UI icon files.

### Task 1: History value object, update behavior, and immediate RPC redaction

**Files:**
- Modify: `modules/file_vault/passwords.py:23-99`
- Modify: `modules/file_vault/backend_server.py:383-426`
- Test: `modules/file_vault/tests/test_passwords.py:16-55`
- Test: `modules/file_vault/tests/test_backend_server.py:451-532`

- [ ] Add failing tests using `monkeypatch` for one timestamp per new entry, one snapshot per effective update, immutable original state, no-op update identity, newest-first order, clock rollback, and five-snapshot cap; add RPC tests proving list/add/update responses omit history from the first history-enabled commit.
- [ ] Run the targeted password model and RPC tests; expect failures because `history`, `PasswordHistorySnapshot`, and redacted serialization do not exist.
- [ ] Add `MAX_PASSWORD_HISTORY = 5`, frozen `PasswordHistorySnapshot`, `history` to `PasswordEntry`, one-clock `new_entry()`, and `updated()` that returns `self` for exact no-op or prepends/truncates a snapshot for effective changes. At the same time split storage serialization from `to_rpc_json()` and change list/add/update callers to the redacted serializer.
- [ ] Run the targeted tests and full existing password tests; expect all to pass with no intermediate history exposure.
- [ ] Commit the four files with message `feat(file_vault): add bounded password history model` plus the required co-author trailer.

### Task 2: Persistence serializers and strict v1/v2 loader

**Files:**
- Modify: `modules/file_vault/passwords.py:43-48,105-169`
- Test: `modules/file_vault/tests/test_passwords.py`

- [ ] Add test helpers that directly encrypt a literal version 1 plaintext fixture using `crypto.wrap_key()` and `crypto.aead_encrypt()` rather than the new serializer.
- [ ] Add failing tests for an independently encrypted literal v1 fixture, byte-identical read-only load, explicit end-to-end v1 load → effective update → save → outer version 2 with the v1 current state preserved as history, v2 round-trip, missing v2 history default, and downgrade tampering.
- [ ] Add an exhaustive load-and-save validation matrix: every required v1/v2 entry and snapshot field missing; each unknown/forbidden field; every text field replaced with null/bool/number/list/object; every timestamp replaced with null/bool/string/list/object/NaN/±Infinity; decrypted top-level and array items replaced with each non-object/list shape; duplicate keys at envelope, entry, and snapshot boundaries; history missing/length 0/5 as valid and null/bool/number/string/object/length 6 as invalid. Every rejection must assert the exact error and byte-identical vault file.
- [ ] Run `python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py -k "vault or format or schema or corrupt or downgrade" -v`; expect strict-validation failures.
- [ ] Implement duplicate-key rejecting JSON parsing, exact envelope version validation, explicit field-set/type/finite-number validation, `from_storage_json()`, `to_storage_json()`, and `to_rpc_json()` serializers. Set `FORMAT_VERSION = 2`; accept literal v1 with exactly legacy fields and reject v1 content containing history.
- [ ] Validate entries before save and map decrypted-content failures to `password.content_corrupted` without including field values.
- [ ] Run the targeted tests and then `python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py -v`; expect all to pass.
- [ ] Commit model/parser/test files with message `feat(file_vault): migrate password vault history safely` plus the required trailer.

### Task 3: Preserve external boundaries and dedupe history safely

**Files:**
- Modify: `modules/file_vault/passwords.py:65-94,229-236`
- Test: `modules/file_vault/tests/test_passwords.py:57-95,146-154`

- [ ] Add failing tests proving current-identical records with different histories are not destructive-dedupe duplicates, fully equivalent histories are duplicates, CSV import still skips a current-field exact match even when the existing entry owns history, and CSV export emits only the current password once.
- [ ] Run `python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py modules/file_vault/tests/test_backend_server.py -k "duplicate or import or export" -v`; expect the differing-history/import separation tests to fail.
- [ ] Make destructive `find_duplicate_ids()` compare complete history while keeping import-time current-field exact matching separate, so re-import cannot create a duplicate solely because existing history differs; ensure CSV export continues to use only current fields.
- [ ] Run the targeted tests; expect pass.
- [ ] Commit with message `fix(file_vault): preserve unique password histories during dedupe` plus trailer.

### Task 4: RPC redaction, request validation, and no-op writes

**Files:**
- Modify: `modules/file_vault/backend_server.py:383-508`
- Test: `modules/file_vault/tests/test_backend_server.py:451-743`

- [ ] Add failing tests that list/add/update responses omit history; add/update reject missing, `history`, and unknown fields with `{ok: false, error: password.invalid_request}`; effective update preserves server history; exact duplicate add, unchanged update, unknown-ID update/delete, empty bulk delete, no-op dedupe, empty/all-duplicate import do not call `save_password_vault`.
- [ ] Run `python -X utf8 -m pytest modules/file_vault/tests/test_backend_server.py -k "password" -v`; expect failures at new request/no-write assertions.
- [ ] Add exact request-key validation helpers; use `to_rpc_json()` in responses; skip save when `updated is e`; skip save for all zero-change paths while retaining requested post-parse CSV source deletion behavior.
- [ ] Ensure unknown-ID operations return existing not-found semantics rather than internal errors.
- [ ] Run password backend tests; expect pass.
- [ ] Commit with message `fix(file_vault): enforce password RPC history boundaries` plus trailer.

### Task 5: Full M1 verification and progress record

**Files:**
- Modify: `task-progress.md`

- [ ] Run syntax check: `python -X utf8 -m py_compile modules/file_vault/passwords.py modules/file_vault/backend_server.py`; expect exit code 0.
- [ ] Run focused suite: `python -X utf8 -m pytest modules/file_vault/tests/test_passwords.py modules/file_vault/tests/test_backend_server.py -v`; expect all pass.
- [ ] Run module regression suite: `python -X utf8 -m pytest modules/file_vault/tests -v`; expect all pass.
- [ ] Before verification, enumerate every pre-existing `modules/file_vault/data/passwords.vault*` artifact and record its path, size, and SHA-256. After all tests, repeat the inventory; expect identical path set, sizes, and hashes, with no file added, removed, or changed.
- [ ] Inspect `git diff --check`; expect no whitespace errors.
- [ ] Inspect `git status --short` and staged files; confirm no `passwords.vault*`, `electron-builder.json5`, `index.html`, icon files, or `app-icon.png` are staged.
- [ ] Update `task-progress.md` with exact command outputs, test counts, unchanged vault hash, and M1 completion status.
- [ ] Commit only the progress record with message `docs(file_vault): record password history M1 verification` plus trailer.

## M1 acceptance checklist

- Legacy version 1 vault loads without a disk write and upgrades only after a real mutation.
- Effective updates preserve the previous state and retain exactly the five newest snapshots.
- No-op operations leave the encrypted vault byte-for-byte unchanged.
- Malformed or downgraded data is rejected without exposing field values.
- List/add/update responses do not expose history; CSV export excludes history.
- Dedupe never deletes a record that owns distinct history.
- Real password vault and unrelated UI icon changes remain untouched and unstaged.
