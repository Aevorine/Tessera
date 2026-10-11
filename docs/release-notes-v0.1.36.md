# Tessera 0.1.36

Security maintenance and responsiveness release for the public Aevorine/Tessera update channel.

## Faster and quieter

- Updates follow the Windows system proxy. Each of the 16 range connections opens its own tunnel, so a proxy does not collapse the download onto a single connection. If the proxy cannot be reached, the updater falls back to a direct connection.
- The backend drops to below-normal CPU priority a few seconds after you switch to another program and returns to normal the moment you come back. Encryption, cleanup scans and indexing keep running; they yield only when the machine is busy.
- Panels open without a loading step. A panel's code is fetched when the pointer rests on its sidebar entry, for the panel you usually open next in this session, and for pinned favourites during idle time. Panels fade in over 140 ms, shorter or not at all on constrained hardware and with reduced motion.
- The sidebar keeps the cleanup suite highlighted on all five of its tabs, and scrolls the highlighted entry into view after a command-palette or menu jump.

## Security

- Update vulnerable UI, Electron and build dependencies; the complete npm tree reports zero known vulnerabilities at publication time.
- Remove unused component-generation tooling while retaining its CSS utilities and MIT attribution.
- Fix CodeQL findings in clipboard detection, plain-text tag cleanup, markdown worker message handling and updater sidecar reads.
- Resolve the optional desktop-control driver to an absolute path from `PATH` only; a same-named executable in the current directory is never run.
- Fix the empty Tailwind `:is()` build warning tracked in issue #1.
- Enable extended CodeQL scanning and audit the complete npm dependency tree in CI.
- Keep signed, hash-checked updates, resumable downloads and 16 concurrent range connections without an application bandwidth cap.

See [the security maintenance record](security-quality-2026-10-11.md) for protocol-specific alert dispositions and limitations. This release was built without running tests; successful scans and compilation are not end-user functional validation.
