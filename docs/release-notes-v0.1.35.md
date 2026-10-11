# Tessera 0.1.35

- Public source and signed Windows releases are hosted at https://github.com/Aevorine/Tessera.
- Application updates use this repository, with 16 concurrent range connections, adaptive chunks, resume records and stalled connection recovery. No application bandwidth cap is applied; network and CDN capacity determine actual throughput.
- Includes the current interface changes and adaptive runtime rendering quality.
- Windows uninstall commands now bypass cmd.exe shell interpretation.
- The standalone packaging command no longer runs Go tests. No tests were run for this release.
- Private configuration, vault data, credentials, signing keys, logs, build debug files and old Git history are excluded from the public source snapshot.
- Distribution consists of the signed Windows portable executable and installer. Retention: latest two releases.

The signing certificate is self-signed and its public key is pinned by the updater. Windows may display a SmartScreen warning on first use.
