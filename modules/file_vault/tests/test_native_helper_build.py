"""Packaging contract for native Windows helper programs."""

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]


def test_prebuild_rebuilds_fingerprint_verifier_when_its_c_source_changes():
    """The packaged app must not silently ship a stale Hello verifier."""
    script = (
        PROJECT_ROOT / "modules" / "file_vault" / "ui" / "scripts" / "build-file-hook.mjs"
    ).read_text(encoding="utf-8")

    assert "fingerprint_verify.c" in script
    assert "fingerprint_verify.exe" in script
    assert "-lruntimeobject" in script
    assert "-lole32" in script
