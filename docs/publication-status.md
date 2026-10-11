# Public repository publication

The canonical source and update repository is https://github.com/Aevorine/Tessera.

Public source is exported from an explicit source file list into an independent Git history. Local automation configuration, private data, signing keys, logs, build caches and previous Git history are not exported. Secret scanning is performed on the exported files and history before upload.

Windows releases contain signed portable and installer executables. The updater uses 16 concurrent range connections without an application bandwidth cap, verifies the downloaded size and digest when available, and checks the pinned signing identity. Network and GitHub CDN capacity determine download speed.

Tests are opt-in through the workflow_dispatch run_tests input. Packaging does not invoke tests.

Repository Issues and pull request templates are included. Security policy and licensing documents are included. GitHub dependency alerts, secret scanning and push protection are enabled. GitHub Insights is generated from repository activity.

GitHub Packages requires separate package scopes and a supported package format; the Windows executable distribution is GitHub Releases. Projects requires project API permission. Wiki is enabled, but a new GitHub Wiki needs its first page initialized before its Git endpoint exists. Existing docs remain available through Code regardless of Wiki initialization.
