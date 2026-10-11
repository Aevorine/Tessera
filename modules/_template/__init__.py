"""Template module - copy this folder to create a new module (see modules/README.md)."""

from modules._template.main import say_hello

MODULE_META = {
    "name": "template",
    "description": "Template/example module - copy this to build a new one.",
    "version": "0.1.0",
}


def register(ctx):
    """Optional: called to wire this module into the app context."""


def run(ctx):
    """Entry point for `python scripts/run.py run template`."""
    return say_hello()
