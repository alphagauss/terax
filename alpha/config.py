"""Alpha 配置模型及本机状态持久化入口。

配置固定保存在 Terax 管理的 Alpha 目录中，可同步业务数据则由 ``data_dir`` 指向。
本模块只负责配置和轻量 JSON 状态，不参与数据库或领域对象生命周期。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

ALPHA_HOME_ENV = "TERAX_ALPHA_HOME"


def get_alpha_home() -> Path:
    """返回 Alpha 固定本机目录。"""

    configured = os.environ.get(ALPHA_HOME_ENV)
    return (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".terax" / "alpha"
    )


class AlphaConfig(BaseModel):
    """Alpha 持久配置。"""

    model_config = ConfigDict(extra="forbid", validate_default=True)

    data_dir: Path = Field(default_factory=lambda: get_alpha_home() / "data")

    @field_validator("data_dir")
    @classmethod
    def normalize_data_dir(cls, value: Path) -> Path:
        """展开数据目录并拒绝依赖当前工作目录的相对路径。"""

        normalized = value.expanduser()
        if not normalized.is_absolute():
            raise ValueError("data_dir 必须是绝对路径")
        return normalized.resolve()

    @property
    def database_dir(self) -> Path:
        """返回 SQLite 数据库目录。"""

        return self.data_dir / "database"

    @property
    def csv_dir(self) -> Path:
        """返回交易日历和证券池 CSV 目录。"""

        return self.data_dir / "csv_db"


def load_config() -> AlphaConfig:
    """加载 Alpha 配置，不存在时生成并保存默认配置。"""

    path = get_alpha_home() / "config.json"
    if path.exists():
        return AlphaConfig.model_validate_json(path.read_text(encoding="utf-8"))

    config = AlphaConfig()
    save_config(config)
    return config


def save_config(config: AlphaConfig) -> None:
    """原子保存 Alpha 配置。"""

    alpha_home = get_alpha_home()
    alpha_home.mkdir(parents=True, exist_ok=True)
    for data_subdir in (config.database_dir, config.csv_dir):
        data_subdir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=data_subdir):
            pass
    path = alpha_home / "config.json"
    content = config.model_dump_json(indent=2) + "\n"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=alpha_home,
            prefix=".config-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def get_state_subdir(name: str) -> Path:
    """返回固定本机状态目录下的命名子目录。"""

    path = get_alpha_home() / "state" / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_json(filename: str, foldername: str = "") -> dict[str, object]:
    """读取 Alpha 本机状态中的 JSON 对象。"""

    parent = get_state_subdir(foldername or "common")
    path = parent / filename
    if not path.exists():
        return {}
    raw_data: object = json.loads(path.read_text(encoding="utf-8"))
    return dict(raw_data) if isinstance(raw_data, dict) else {}


def save_json(
    filename: str,
    data: dict[str, object],
    foldername: str = "",
) -> None:
    """保存 JSON 对象到 Alpha 固定本机状态目录。"""

    path = get_state_subdir(foldername or "common") / filename
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
        newline="\n",
    )
