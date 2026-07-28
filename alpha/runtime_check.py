"""Alpha Python 运行环境检查。

本模块是 Python 运行依赖的唯一检查入口，以稳定 JSON 向 Terax Rust 生命周期层报告结果。
"""

from __future__ import annotations

import importlib
import json
import re
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

MINIMUM_PYTHON = (3, 11)
RUNTIME_REQUIREMENTS = Path(__file__).with_name("requirements-runtime.txt")
IMPORT_NAME_OVERRIDES = {
    "python-dotenv": "dotenv",
    "ta-lib": "talib",
    "typing-extensions": "typing_extensions",
}


@dataclass(frozen=True)
class RuntimeCheck:
    """可序列化的 Alpha Python 运行环境检查结果。"""

    version: str
    minimum_version: str
    supported: bool
    missing_packages: list[str]
    import_errors: list[str]


def load_runtime_imports(
    requirements_path: Path = RUNTIME_REQUIREMENTS,
) -> list[tuple[str, str]]:
    """从运行依赖文件解析发行包名和导入名。

    Args:
        requirements_path: Alpha 运行依赖文件。

    Returns:
        按文件顺序排列的发行包名和 Python 导入名。
    """

    imports: list[tuple[str, str]] = []
    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        requirement = raw_line.partition("#")[0].strip()
        if not requirement or requirement.startswith("-"):
            continue
        package = re.split(r"[\[<>=!~;]", requirement, maxsplit=1)[0].strip()
        normalized = package.lower().replace("_", "-")
        module = IMPORT_NAME_OVERRIDES.get(
            normalized,
            normalized.replace("-", "_"),
        )
        imports.append((normalized, module))
    return imports


def inspect_runtime(
    *,
    version_info: Sequence[int] | None = None,
    importer: Callable[[str], object] = importlib.import_module,
    runtime_imports: Sequence[tuple[str, str]] | None = None,
) -> RuntimeCheck:
    """检查 Python 版本和 Alpha 必需模块。

    Args:
        version_info: 测试可注入的 Python 版本序列。
        importer: 测试可注入的模块导入函数。
        runtime_imports: 测试可注入的发行包名和导入名。

    Returns:
        结构化运行环境检查结果。
    """

    version = tuple(version_info or sys.version_info[:3])
    missing_packages: list[str] = []
    import_errors: list[str] = []
    for package, module in runtime_imports or load_runtime_imports():
        try:
            importer(module)
        except ModuleNotFoundError as exc:
            if exc.name == module:
                missing_packages.append(package)
            else:
                import_errors.append(f"{package}: {type(exc).__name__}: {exc}")
        except Exception as exc:
            import_errors.append(f"{package}: {type(exc).__name__}: {exc}")

    return RuntimeCheck(
        version=".".join(str(part) for part in version[:3]),
        minimum_version=".".join(str(part) for part in MINIMUM_PYTHON),
        supported=version[:2] >= MINIMUM_PYTHON,
        missing_packages=missing_packages,
        import_errors=import_errors,
    )


def main() -> None:
    """输出供 Terax Rust 解析的单行 JSON 检查结果。"""

    print(
        json.dumps(
            asdict(inspect_runtime()),
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
