#!/usr/bin/env python
"""CLI entry point for the hub: `list` or `run <module_name>`."""

import argparse
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.registry import discover_modules  # noqa: E402


def cmd_list(_args: argparse.Namespace) -> int:
    modules = discover_modules()
    if not modules:
        print("No modules found. See modules/README.md to add one.")
        return 0
    for info in modules.values():
        print(f"{info.name} (v{info.version}) - {info.description}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    modules = discover_modules()
    info = modules.get(args.module)
    if info is None:
        print(f"Module '{args.module}' not found. Run `list` to see available modules.")
        return 1
    if not hasattr(info.module, "run"):
        print(f"Module '{args.module}' has no run() entry point.")
        return 1
    info.module.run(ctx={})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="run.py", description="Ideal1 hub CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list", help="List discovered modules").set_defaults(func=cmd_list)

    run_parser = subparsers.add_parser("run", help="Run a module's entry point")
    run_parser.add_argument("module", help="Module name (folder under modules/)")
    run_parser.set_defaults(func=cmd_run)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
