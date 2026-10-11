"""电脑清理套件：扫描、分级、清理、还原。改这个包前先读这四条约束：

1. 扫描只读，清理才写：scanner 只返回 `CleanItem` 清单，删除统一走 `actions.py`（备份、白名单复核、还原记录）。
2. 每项必须说明「删了会怎样」：`importance` 五级 + `reason`；没把握的往更重要判（`UNKNOWN` 落在 `OPTIONAL`）。
3. 锁死项在后端拦：`locked=True` 即使前端传回勾选，`actions.py` 也拒绝。
4. 耗时扫描都要接 `should_cancel` 并按块报进度，否则卡主线程且停不下来。

模块分工：model.py 数据类型；importance.py 分级引擎；safety.py 结果交界面前的闸口；
processes.py 文件锁预判；paths.py 已知目录；junk/privacy/space/memory/startup/shellext/software/
registry_clean/popup/toolbox 各类 scanner；actions.py 唯一执行入口 + 还原；elevate.py 提权助手；
service.py 对外门面，backend_server 只跟它打交道。
"""

from modules.file_vault.pcclean.model import (  # noqa: F401
    CleanItem,
    Importance,
    ScanReport,
    ScanTask,
)

__all__ = ["CleanItem", "Importance", "ScanReport", "ScanTask"]
