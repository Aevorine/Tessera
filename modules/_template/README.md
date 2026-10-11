# _template

新建模块的起点，不会被 `core/registry.py` 发现（文件夹名以 `_` 开头）。

## 用法

1. 复制整个 `_template/` 文件夹，改名为 `modules/<your_module_name>/`（去掉下划线前缀）。
2. 打开新文件夹里的 `__init__.py`，把 `MODULE_META` 的 `name`/`description`/`version` 改成你的模块信息，并把 `from modules._template.main import ...` 改成 `from modules.<your_module_name>.main import ...`。
3. 打开 `main.py`，把 `say_hello()` 替换成你实际要实现的逻辑。
4. 运行 `python scripts/run.py list`，确认新模块名出现在列表里。
