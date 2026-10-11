# Security and quality maintenance — 2026-10-11

This update addresses the initial public repository's security alerts, dependency pull requests #2–#9 and CSS issue #1. No unit, integration, GUI or end-user tests were run. Static analysis, dependency audits and compilation do not establish runtime correctness.

## Dependency remediation

The original npm audit reported 43 vulnerable nodes: 3 critical, 23 high, 16 moderate and 1 low. After updating the lockfile, both the complete tree and `--omit=dev` report **0 vulnerabilities**. GitHub counts advisories rather than npm's dependency nodes, so those counts are not interchangeable.

DOMPurify, markdown-it, Electron, Vite and Vitest are updated together. Vitest 5 requires a compatible Vite and Node version; CI uses Node 24. Transitive overrides patch xmldom, js-yaml, brace-expansion, undici and http-cache-semantics. Updating global-agent removes the unpatched sprintf-js dependency. The unused shadcn generation CLI was removed because its braces dependency has no published fixed version. Its required CSS utilities are vendored without modifications, with the MIT licence and attribution retained. No dependency advisory is suppressed.

The security workflow now audits development dependencies too: Electron is a development dependency but is bundled in the application. Third-party notices were regenerated. Installation of updated dependencies used `--ignore-scripts`.

## CodeQL remediation

GitHub CodeQL default setup is enabled with the extended query suite for JavaScript/TypeScript, Python and Go. Initial analysis found nine alerts. Seven code changes address:

- Incorrect Unicode ranges in clipboard language detection.
- Tag stripping that could produce another tag after a single replacement; a shared linear scanner now extracts plain text without constructing intermediate markup or retaining angle brackets.
- Inline JavaScript quote escaping in a design prototype; the event handler now uses an integer index rather than interpolating a filename.
- Download sidecar stat/read race: open once, inspect and read the same handle, cap the read at 64 KiB, and reject path-bearing asset names.
- An incomplete shell language-identification boundary.
- Missing message origin and payload checks in the dedicated markdown worker.

Two protocol-specific findings require contextual disposition, rather than incompatible algorithm changes:

1. **HIBP SHA-1 range lookup** (`breach_check.py`): the [official API](https://haveibeenpwned.com/API/v3#SearchingPwnedPasswordsByRange) requires a SHA-1 password fingerprint. Only its first five hexadecimal characters are sent over HTTPS, with `Add-Padding: true`; response suffixes are matched locally. The SHA-1 value is not stored or used for authentication or password key derivation. `usedforsecurity=False` makes that purpose explicit. Changing it to SHA-256 would break the external protocol. This is a false positive for password-storage hashing, not an exemption for actual password storage.
2. **Ephemeral QUIC TLS certificate** (`core/transport/quic.go`): QUIC is the carrier, not the peer authentication layer. Each endpoint generates a self-signed temporary certificate. Reconnection uses Noise_IK with the previously paired `PeerStatic` key (`core/node/reconnect.go`); the responder checks `FindByDHPub` and `Usable` before creating a session (`core/node/node.go`). First pairing uses Noise_XX, checks the QR public key where provided, derives SAS from the handshake transcript and requires bilateral acceptance before `PutPeer` (`core/node/pairing.go`). No application session is admitted based only on the unverified TLS certificate. This is a false positive for absent peer authentication in this layered protocol. It does not claim TLS authenticates the device.

## Other static findings and evidence

Semgrep security-audit/CI rules ran with telemetry disabled. Seven audit-pattern warnings remain, reviewed as contextual rather than exploitable findings: the HIBP SHA-1 lookup above; two uses of pseudorandom jitter for reconnection/mDNS (not keys or tokens); three external-process launch patterns (signed updater executables or local build commands, not a shell executing remote input); and an HTTP request to the loopback-only development layout probe. These warnings remain visible and are not suppressed.

The installed govulncheck initially could not parse Go 1.27 source because it was built using Go 1.26. Running the official tool with the project's selected Go toolchain completed: **0 reachable vulnerabilities**, 0 in imported packages, 6 advisory matches in required modules whose vulnerable symbols are not called. The GitHub Python dependency audit also passed on the existing PR run.

Local ESLint, internationalization consistency, TypeScript compilation and Vite production compilation passed. Tailwind now scans application templates explicitly, excluding Playwright `:visible` selectors; the empty `:is()` compilation warning is absent. No broad scan exclusions or alert blanket-dismissal are used to obtain these results.

GitHub Secret Scanning's alert API initially denied access but became readable on a later request: it returned **0 alerts**. A separate redacted Gitleaks scan of the exact staged publication snapshot (22.88 MB) also found **0 secrets**. A scan of the whole local working directory found session/cache/virtual-environment matches; those private folders are ignored and absent from the publication tree, not waived into the upload. Public reachable history is scanned separately before pushing; local private-history branches are never published.

## Follow-up review before the 0.1.36 release

A second Semgrep pass (security-audit, Python, JavaScript, TypeScript and Go rule packs, telemetry disabled) over 481 source files reported eight findings. One was a real weakness and is fixed:

- **Uncontrolled search path for the optional desktop-control driver** (`desktop_control.py`): the driver was started by bare name. On Windows, process creation searches the current directory before `PATH`, and the current directory can be a downloads folder when the application is started through "Open with". A same-named executable placed there would have run with the user's privileges once the AI desktop tools were used. The driver is now resolved to an absolute path from absolute `PATH` entries only; relative overrides are rejected.

The MD5 value in the cleanup toolbox's file-checksum tool is displayed for comparison with a vendor's published checksum and takes no part in any security decision; it is now created with `usedforsecurity=False`. The remaining six findings are the contextual patterns already described above (HIBP SHA-1, reconnection jitter, signed updater launches, the local build script and the loopback layout probe).

A redacted Gitleaks scan of the published history (3 commits, 23.14 MB) found **0 secrets**.

The update client's new system-proxy route keeps the existing trust model: the proxy carries an opaque TLS tunnel, certificate validation is unchanged, every hop is still checked against the GitHub host allow-list, and installation still depends on the Authenticode signature. It has not been exercised against a live proxy.
