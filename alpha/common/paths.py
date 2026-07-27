"""运行时路径辅助函数。"""

from __future__ import annotations

import json
from pathlib import Path
import sys

if sys.platform == "win32":
    WORKSPACE_DIR: Path = Path("D:/OneDrive/project/alphagogo/.data")
else:
    WORKSPACE_DIR: Path = Path.home() / "OneDrive/project/alphagogo/.data"


def _ensure_path(path: Path) -> Path:
    """确保路径所属目录存在。

    Args:
        path: 目录或文件路径。

    Returns:
        原始路径。
    """

    if path.suffix:
        path.parent.mkdir(parents=True, exist_ok=True)
    else:
        path.mkdir(parents=True, exist_ok=True)
    return path


def get_data_dir() -> Path:
    """返回运行数据目录。
    """

    return WORKSPACE_DIR


def get_config_path() -> Path:
    """返回配置文件路径。

    Args:
        无。

    Returns:
        运行数据目录下的配置文件路径。
    """

    return _ensure_path(get_data_dir() / "config.json")


def get_runtime_subdir(name: str) -> Path:
    """返回运行数据目录下的命名子目录。

    Args:
        name: 子目录名称。

    Returns:
        已确保存在的运行时子目录。
    """

    return _ensure_path(get_data_dir() / name)


def get_logs_dir() -> Path:
    """返回日志目录。

    Args:
        无。

    Returns:
        已确保存在的日志目录。
    """

    return get_runtime_subdir("logs")


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
