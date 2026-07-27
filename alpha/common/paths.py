"""Alpha 运行时路径辅助函数。

所有持久数据和日志目录由 Terax 启动环境注入；独立开发运行时回退到用户目录，
不依赖源码位置、当前工作目录或机器特定的绝对路径。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DATA_DIR_ENV = "TERAX_ALPHA_DATA_DIR"
LOG_DIR_ENV = "TERAX_ALPHA_LOG_DIR"


def _ensure_directory(path: Path) -> Path:
    """确保目录存在。

    Args:
        path: 需要创建的目录路径。

    Returns:
        已创建的目录路径。
    """

    path.mkdir(parents=True, exist_ok=True)
    return path


def _ensure_file_parent(path: Path) -> Path:
    """确保文件的父目录存在。

    Args:
        path: 目标文件路径。

    Returns:
        原始文件路径。
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def get_data_dir() -> Path:
    """返回并创建 Alpha 持久数据目录。

    Returns:
        Terax 注入或用户目录下的 Alpha 数据目录。
    """

    configured = os.environ.get(DATA_DIR_ENV)
    path = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".terax" / "alpha" / "data"
    )
    return _ensure_directory(path)


def get_config_path() -> Path:
    """返回配置文件路径。

    Args:
        无。

    Returns:
        运行数据目录下的配置文件路径。
    """

    return _ensure_file_parent(get_data_dir() / "config.json")


def get_runtime_subdir(name: str) -> Path:
    """返回运行数据目录下的命名子目录。

    Args:
        name: 子目录名称。

    Returns:
        已确保存在的运行时子目录。
    """

    return _ensure_directory(get_data_dir() / name)


def get_logs_dir() -> Path:
    """返回并创建 Alpha 日志目录。

    Returns:
        Terax 注入或默认的 Alpha 日志目录。
    """

    configured = os.environ.get(LOG_DIR_ENV)
    path = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".terax" / "logs" / "alpha"
    )
    return _ensure_directory(path)


def get_file_path(filename: str) -> Path:
    """返回运行数据目录下的文件路径。

    Args:
        filename: 文件名。

    Returns:
        文件在运行数据目录中的路径。
    """

    return get_data_dir() / filename


def load_json(filename: str, foldername: str = "") -> dict[str, object]:
    """读取运行数据目录中的 JSON 文件。

    Args:
        filename: JSON 文件名。
        foldername: 可选运行时子目录名。

    Returns:
        JSON 对象；文件不存在时返回空字典。
    """

    if foldername:
        parent_path: Path = get_runtime_subdir(foldername)
        filepath: Path = parent_path.joinpath(filename)
    else:
        filepath: Path = get_file_path(filename)

    if filepath.exists():
        with open(filepath, mode="r", encoding="utf-8") as file:
            raw_data: object = json.load(file)
        if isinstance(raw_data, dict):
            return dict(raw_data)
    return {}


def save_json(
    filename: str,
    data: dict[str, object],
    foldername: str = "",
) -> None:
    """保存 JSON 文件到运行数据目录。

    Args:
        filename: JSON 文件名。
        data: 待保存的 JSON 对象。
        foldername: 可选运行时子目录名。

    Returns:
        无返回值。
    """

    if foldername:
        parent_path: Path = get_runtime_subdir(foldername)
        filepath: Path = parent_path.joinpath(filename)
    else:
        filepath: Path = get_file_path(filename)

    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, mode="w", encoding="utf-8", newline="\n") as file:
        json.dump(data, file, ensure_ascii=False, indent=2, default=str)
