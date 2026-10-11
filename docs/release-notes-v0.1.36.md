# Tessera 0.1.36

Security maintenance release for the public Aevorine/Tessera update channel.

- Update vulnerable UI, Electron and build dependencies; the complete npm tree reports zero known vulnerabilities at publication time.
- Remove unused component-generation tooling while retaining its CSS utilities and MIT attribution.
- Fix CodeQL findings in clipboard detection, plain-text tag cleanup, markdown worker message handling and updater sidecar reads.
- Fix the empty Tailwind `:is()` build warning tracked in issue #1.
- Enable extended CodeQL scanning and audit the complete npm dependency tree in CI.
- Keep signed, hash-checked updates, resumable downloads and 16 concurrent range connections without an application bandwidth cap.

See [the security maintenance record](security-quality-2026-10-11.md) for protocol-specific alert dispositions and limitations. This release was built without running tests; successful scans and compilation are not end-user functional validation.
