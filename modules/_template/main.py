"""Example logic for the template module, showing core.config and core.logging usage."""

from core.config import load_config
from core.logging import get_logger

logger = get_logger(__name__)


def say_hello() -> str:
    config = load_config()
    name = config.get("greet_name", "world")
    message = f"Hello, {name}! This is the template module."
    logger.info(message)
    return message
