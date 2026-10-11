"""Shared logging setup for all modules."""

import logging

_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_configured = False


def get_logger(name: str) -> logging.Logger:
    global _configured
    if not _configured:
        logging.basicConfig(level=logging.INFO, format=_FORMAT)
        _configured = True
    return logging.getLogger(name)
