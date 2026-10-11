# Local patches to github.com/grandcat/zeroconf v1.0.0

Pulled in through `replace` in `../../go.mod`. Upstream is unmaintained, so the fix
is carried here instead of waiting for a release. Everything else is v1.0.0 verbatim
(MIT, see LICENSE).

1. `server.go`: `shutdownEnd.Add(1)` moved from inside `recv4`/`recv6` to `mainloop`,
   before the goroutines start. Upstream's placement races with `shutdown()`'s
   `Wait()` when a server is shut down right after `Register`. The race detector
   flagged it in CI (`TestRendezvousSettingsRoundTrip`, 2026-09-25), and it can
   let `Wait` return before a receiver has registered.

2. `server.go`: `Register` and `RegisterProxy` call `s.mainloop()` inline instead of
   `go s.mainloop()`. After patch 1, `mainloop` only registers and starts the
   receivers, so it returns at once. Run as a goroutine, its `Add(1)` still had no
   happens-before edge with `shutdown()`'s `Wait()`, and the race detector flagged it
   (2026-09-26) once discovery began re-publishing after network changes, which shuts
   a server down moments after registering it.
