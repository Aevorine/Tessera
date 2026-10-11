"""让 pytest 也能跑 test_delete.py。

该文件两用（可脚本直跑，也被 pytest 收集），pytest 下 `tmp` 参数无 fixture 而报错；
fixture 补在这里以保留脚本直跑能力，且返回字符串路径（脚本侧传的就是字符串）。
"""

import pytest


@pytest.fixture
def tmp(tmp_path):
    return str(tmp_path)
