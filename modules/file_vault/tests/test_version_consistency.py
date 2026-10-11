"""版本号必须四处一致。

同一版本号在四种构建系统里各声明一遍，升版靠手改，无机制保证一致：
pyproject.toml、modules/file_vault/__init__.py（关于页读它）、
modules/file_vault/ui/package.json（electron-builder 读它）、
crossdevice/android/app/build.gradle.kts（APK versionName）。
漏一个不会报错，只是关于页版本与文件名对不上，用户报 bug 时你会按错的版本复现。
Android 的 versionCode 才是系统判断"是否更新"的整数，versionName 变而 versionCode 不变会被拒绝安装，
故 versionCode 必须随版本单调递增。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

PYPROJECT = REPO_ROOT / "pyproject.toml"
MODULE_INIT = REPO_ROOT / "modules" / "file_vault" / "__init__.py"
UI_PACKAGE = REPO_ROOT / "modules" / "file_vault" / "ui" / "package.json"
UI_LOCK = REPO_ROOT / "modules" / "file_vault" / "ui" / "package-lock.json"
ANDROID_GRADLE = (
    REPO_ROOT / "modules" / "file_vault" / "crossdevice" / "android" / "app"
    / "build.gradle.kts"
)

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _pyproject_version() -> str:
    for line in PYPROJECT.read_text(encoding="utf-8").splitlines():
        # `[project]` 段里的第一个 `version = "..."`。不用 tomllib：本机是
        # Python 3.9，那个模块要 3.11 才有。
        match = re.match(r'^version\s*=\s*"([^"]+)"', line.strip())
        if match:
            return match.group(1)
    raise AssertionError("pyproject.toml 里找不到 version")


def _module_meta_version() -> str:
    text = MODULE_INIT.read_text(encoding="utf-8")
    match = re.search(r'"version"\s*:\s*"([^"]+)"', text)
    assert match, "modules/file_vault/__init__.py 的 MODULE_META 里找不到 version"
    return match.group(1)


def _json_version(path: Path) -> str:
    return str(json.loads(path.read_text(encoding="utf-8"))["version"])


def _gradle_field(name: str) -> str:
    text = ANDROID_GRADLE.read_text(encoding="utf-8")
    match = re.search(rf'^\s*{name}\s*=\s*"?([^"\s]+)"?\s*$', text, re.M)
    assert match, f"build.gradle.kts 里找不到 {name}"
    return match.group(1)


def _sources() -> dict:
    return {
        "pyproject.toml": _pyproject_version(),
        "file_vault/__init__.py (MODULE_META)": _module_meta_version(),
        "ui/package.json": _json_version(UI_PACKAGE),
        "android build.gradle.kts (versionName)": _gradle_field("versionName"),
    }


def test_all_four_version_declarations_agree():
    versions = _sources()
    distinct = set(versions.values())
    assert len(distinct) == 1, (
        "版本号在这几处对不上，升版时漏改了：\n"
        + "\n".join(f"  {where:42} = {what}" for where, what in versions.items())
    )


def test_versions_are_plain_semver():
    """用 `0.1.4`，不能是 `v0.1.4` 或 `0.1.4-beta`：
    electron-builder 把 version 拼进文件名和 exe 版本资源，Windows 版本资源只接受纯数字段，
    带前后缀会在打包最后一步才失败。"""
    for where, value in _sources().items():
        assert SEMVER.match(value), f"{where} 的版本号不是纯 semver: {value!r}"


def test_lockfile_version_matches_package_json():
    """package-lock.json 也要跟上：曾出现 package.json 升到 0.1.3 而 lockfile 仍是 0.1.0。
    不影响产物版本，但会让追查"依赖树属于哪个版本"的人得到错误答案。"""
    package = _json_version(UI_PACKAGE)
    lock = json.loads(UI_LOCK.read_text(encoding="utf-8"))
    assert lock.get("version") == package, (
        f"package-lock.json 根 version = {lock.get('version')!r}，"
        f"package.json = {package!r}"
    )
    assert lock["packages"][""]["version"] == package, (
        f"package-lock.json packages[''] = {lock['packages']['']['version']!r}，"
        f"package.json = {package!r}"
    )


def test_android_version_code_is_a_positive_integer():
    code = _gradle_field("versionCode")
    assert code.isdigit() and int(code) > 0, f"versionCode 不是正整数: {code!r}"


def test_android_version_code_increases_whenever_the_version_name_does():
    """改了 versionName 就必须把 versionCode 调大，判据取自与上一个提交的对比，而不是套公式。
    Android 唯一硬性要求是单调递增；钉死算式会拦下紧急重发（同 versionName、新 versionCode）。
    拿不到 git 历史（浅克隆、源码 tarball）时跳过。"""
    import subprocess

    try:
        previous = subprocess.run(
            ["git", "show", f"HEAD:{ANDROID_GRADLE.relative_to(REPO_ROOT).as_posix()}"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return  # 没有 git，跳过
    if previous.returncode != 0:
        return  # 不在 git 仓库里，或这个文件还没被提交过

    def field(text: str, name: str):
        match = re.search(rf'^\s*{name}\s*=\s*"?([^"\s]+)"?\s*$', text, re.M)
        return match.group(1) if match else None

    old_name = field(previous.stdout, "versionName")
    old_code = field(previous.stdout, "versionCode")
    if old_name is None or old_code is None:
        return

    new_name = _gradle_field("versionName")
    new_code = int(_gradle_field("versionCode"))

    if new_name == old_name:
        return  # 版本号没动，这条不适用

    assert new_code > int(old_code), (
        f"versionName 从 {old_name} 改到了 {new_name}，但 versionCode 还是 {new_code}"
        f"（上一个提交也是 {old_code}）。Android 靠 versionCode 判断新旧，"
        "忘了递增的表现是安装包完全正常、系统却拒绝安装，而报的错跟版本毫无关系。"
    )
