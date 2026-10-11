# Ideal1 — 个人自动化中枢（项目本地约定）

> **这份文件只写 Ideal1 这个代码仓库自己的开发约定。** 通用的自动化操作规则（工具选择、危险分级、后台执行等）如果你有，放在用户级全局指令里，不要写进这里——两边重复迟早会不一致。

这是一个通用的个人自动化/智能体中枢项目，不绑定具体业务场景。新的应用场景通过在 `modules/` 下新增一个模块文件夹接入，不需要改动核心代码。

## 结构地图

```
core/       跨模块公共基础设施：config.py（配置）、logging.py（日志）、registry.py（模块发现）、proc.py（外部命令）
modules/    可插拔功能模块，一个子文件夹 = 一个独立场景。规范见 modules/README.md（权威文档）
scripts/    CLI 入口：run.py（list / run <module>）
docs/       项目文档，architecture.md 是结构地图的展开版
tests/      冒烟测试
```

## 运行约定

- Python ≥ 3.9（本机 3.9）。
- 中文输出 / 绘图用 UTF-8：`python -X utf8 scripts/run.py ...`；matplotlib 无窗口渲染设 `MPLBACKEND=Agg`。
- 模块之间**不互相 import**，只依赖 `core/`。共用逻辑提升到 `core/`。
- 模块内部可混用 JavaScript / C，统一通过 `core/proc.py` 的 `run_command()` 调用外部工具。

## 新增一个场景

复制 `modules/_template/` → `modules/<name>/`，改 `MODULE_META`，实现逻辑，`python scripts/run.py list` 确认被发现。详细规范只在 `modules/README.md` 一处，不在这里重复。

---
本文件历次修订见 git 历史。
