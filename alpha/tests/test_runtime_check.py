"""测试 Alpha Python 运行环境检查。

锁定最低 Python 版本、缺失依赖和损坏依赖的结构化报告，避免 Rust 复制依赖知识。
"""

from __future__ import annotations

import json
from pathlib import Path

import alpha.runtime_check as runtime_check


def test_runtime_imports_are_derived_from_requirements(tmp_path: Path) -> None:
    """验证运行检查以 requirements 文件作为完整依赖清单。"""

    requirements = tmp_path / "requirements-runtime.txt"
    requirements.write_text(
        "fastapi>=1\nuvicorn[standard]\npython-dotenv\n"
        "typing-extensions\n-r ignored.txt\n",
        encoding="utf-8",
    )

    assert runtime_check.load_runtime_imports(requirements) == [
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("python-dotenv", "dotenv"),
        ("typing-extensions", "typing_extensions"),
    ]


def test_runtime_requirements_include_websocket_transport() -> None:
    """验证完整运行清单会显式检查 WebSocket 驱动。"""

    assert ("websockets", "websockets") in runtime_check.load_runtime_imports()


def test_runtime_check_reports_supported_environment() -> None:
    """验证受支持版本和可导入依赖会通过检查。"""

    result = runtime_check.inspect_runtime(
        version_info=(3, 11, 9),
        importer=lambda _module: object(),
    )

    assert result.version == "3.11.9"
    assert result.minimum_version == "3.11"
    assert result.supported is True
    assert result.missing_packages == []
    assert result.import_errors == []


def test_runtime_check_distinguishes_missing_and_broken_packages() -> None:
    """验证缺失模块和导入异常分别报告。"""

    def importer(module: str) -> object:
        """按模块名返回测试导入结果。"""

        if module == "fastapi":
            raise ModuleNotFoundError("No module named 'fastapi'", name="fastapi")
        if module == "talib":
            raise OSError("missing native library")
        return object()

    result = runtime_check.inspect_runtime(
        version_info=(3, 10, 14),
        importer=importer,
    )

    assert result.supported is False
    assert result.missing_packages == ["fastapi"]
    assert result.import_errors == ["ta-lib: OSError: missing native library"]


def test_runtime_check_main_emits_ascii_json(
    monkeypatch,
    capsys,
) -> None:
    """验证命令入口输出稳定的 ASCII JSON。"""

    monkeypatch.setattr(
        runtime_check,
        "inspect_runtime",
        lambda: runtime_check.RuntimeCheck(
            version="3.11.9",
            minimum_version="3.11",
            supported=True,
            missing_packages=[],
            import_errors=[],
        ),
    )

    runtime_check.main()

    assert json.loads(capsys.readouterr().out) == {
        "version": "3.11.9",
        "minimum_version": "3.11",
        "supported": True,
        "missing_packages": [],
        "import_errors": [],
    }
