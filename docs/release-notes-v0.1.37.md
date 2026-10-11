# Tessera 0.1.37

Update-source release: the same signed packages are published to two repositories, and the application can follow either.

## Update source

- **Windows:** Settings → Application updates has an **Update source** choice. The default is the main repository, `Aevorine/Tessera`; the alternative is the mirror, `Aevorine/Tessera-releases`. Switching discards the previous check result, so check again afterwards.
- **Android:** the update card has a switch for the same mirror.
- The choice is limited to these two built-in repositories. No address can be typed in, and the source does not affect trust: Windows installs only packages signed with the pinned key, and Android accepts only packages carrying the installed signing key.
- 0.1.36 and 0.1.37 are published to both repositories, so installations of 0.1.33 and earlier, which only know the mirror, can update again.

## Also in this release

- The last open code-scanning alert is resolved: the TypeScript detection pattern in clipboard language labels is split into two explicit tests.
- The rendezvous container image workflow and its Dockerfile now live in this repository, alongside a code of conduct.

Everything in [0.1.36](release-notes-v0.1.36.md) is included: system-proxy-aware update downloads, foreground-aware backend priority, panel prefetching and the security fixes.

This release was built without running tests; successful scans and compilation are not end-user functional validation.
