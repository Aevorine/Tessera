# 模块开发规范 (Module Convention)

`modules/` 下每个子文件夹是一个独立的、可插拔的应用场景。新增功能场景 = 新建一个模块文件夹，不需要改动 `core/` 或其他模块。

## 新建一个模块

1. 复制 `modules/_template/` 整个文件夹到 `modules/<your_module_name>/`。
2. 编辑 `__init__.py` 里的 `MODULE_META`：

   ```python
   MODULE_META = {
       "name": "your_module_name",
       "description": "一句话说明这个模块做什么",
       "version": "0.1.0",
   }
   ```

3. 在 `main.py`（或你新增的文件）里实现具体逻辑，通过 `core.config.load_config()` 读配置、`core.logging.get_logger(__name__)` 记日志。
4. 如果模块需要被 `scripts/run.py run <name>` 直接调用，在 `__init__.py` 里实现 `run(ctx)`。
5. 跑 `python scripts/run.py list`，确认新模块出现在列表里。

## 发现规则

`core/registry.py` 用 `pkgutil.iter_modules` 扫描 `modules/` 下的所有子包：

- 文件夹名以 `_` 开头（例如 `_template`）→ **跳过**，不会被发现。这既标记"这是模板/未启用"，也复用同一条规则实现跳过逻辑。
- 缺少 `MODULE_META` 字典，或 `MODULE_META` 缺少 `name`/`description`/`version` 任一字段 → **跳过并记录警告**，不会让整体发现流程崩溃。
- 导入过程中抛异常的模块 → **跳过并记录警告**（软失败，不影响其他模块被发现）。

## 约束

- 模块之间不要互相 import——只能依赖 `core/`。如果两个模块都需要同一段逻辑，把它提升到 `core/` 里。
- 模块自己的输出文件（图表、报告等）放在模块自己的文件夹内（例如 `modules/<name>/reports/`），不要写到项目根目录或其他模块目录。

## 多语言模块 (JavaScript / C)

`core/registry.py` 的模块发现机制是 Python 的，但**模块内部**可以用 JavaScript 或 C 做实际工作——Python 只负责编排/调用。约定：

- JS 代码放在模块自己的 `js/` 子文件夹里，带自己的 `package.json`；从 `main.py` 用 `core.proc.run_command(["node", "js/script.js", ...])` 调用。
- C 代码放在模块自己的 `c/` 子文件夹里；需要先用 `gcc` 编译出可执行文件（可以在 `run()` 里按需编译，或提前编译好存在模块目录下），再用 `core.proc.run_command([...])` 调用生成的可执行文件。
- 统一通过 `core/proc.py` 的 `run_command()` / `require_tool()` 调用外部工具，而不是裸 `subprocess.run`——它会在工具缺失时抛出清晰的 `ToolNotFoundError`，并复用 `core.logging` 记录执行日志。
- 生成的编译产物（`*.exe`/`*.o`/`node_modules/`）不要提交到 git，已在项目根 `.gitignore` 里排除。

本机已确认可用的工具链：Python 3.9、Node.js（`node`/`npm`）、gcc（MinGW-w64，含 `mingw32-make`）。没有装 `cmake`/`clang`/MSVC `cl`，如果某个模块需要它们，先确认本机已安装。

<!-- PVWM3|U2FsdGVkX19cokVkViEHa9jwHX1v/Mr3mpl090qsnwqQPegoKBdbqiInIE+qigxkwJqNY8GRe5NEoSMjxdhrlyI4JHs+4PoxJDtPkAORand4+3GBFdZkNCrpiVsI38PsXjVJm4HM31hdrPv4RHsZzd83IczY93b0gLj9CsGIQn2SQhvuNtjsKCXmxIymp3i9qfiapzwNSfqUDBTr6HUwRvaSnOWYFe10vK1j+CejK4PHKV50zkaXneVxx9jvZDWupMOXH3BHU65UlKkeWZP8kJCCOVXQz6vUQtGtJRL3dyFe+EIzQqDYQ3wLGcnGoTlZEQGXnWO6mfSVf1PFh6+4N4vkKsqkfL6vHagWjJZ7IFhknI+SEqz2UxgJCwTXKotwHB0neXWJTzJloLSn/QoBGqYQIYRSgIMTGqZGK/mXOVGMblwVUkX7xNquhKX8lXo2KZTKiER6E020rMH9ein8y5hPjpBNt4yyBCycfvmzON1pc29i340XIQ5GQND3arT4uxTArpqhXmZSeKFZKan2q55uCAk2P4S0lbWa8SiwPH3t0k2th80dPsW/Jp14XK68LH/AaoujwOHJBwcM2adNyJ+5yVwjSCQl7wmrTqiBpzZByABPWSb/rhgyYN8E1qN/TJejziwzqObbvUQsLb5SyWSKLTJN+Puh9HVdLPf9ipY= -->
