import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core.registry import discover_modules


def test_template_module_is_skipped():
    modules = discover_modules()
    assert "_template" not in modules


def test_discovered_modules_all_have_valid_metadata():
    # registry 会静默跳过 MODULE_META 不完整的模块，所以这里只检查已被发现的是否完整。
    modules = discover_modules()
    for name, info in modules.items():
        assert info.name
        assert info.description
        assert info.version
