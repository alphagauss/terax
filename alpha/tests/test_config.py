"""Alpha 配置生成、校验和原子持久化测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from alpha.config import AlphaConfig, get_alpha_home, load_config, save_config


def test_missing_config_is_created_with_default_data_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """配置不存在时应在固定 Alpha 目录生成默认文件。"""

    alpha_home = tmp_path / "alpha.home"
    monkeypatch.setenv("TERAX_ALPHA_HOME", str(alpha_home))

    config = load_config()

    assert get_alpha_home() == alpha_home
    assert config.data_dir == (alpha_home / "data").resolve()
    assert config.database_dir == (alpha_home / "data" / "sqlite_db").resolve()
    assert config.csv_dir == (alpha_home / "data" / "csv_db").resolve()
    assert config.database_dir.is_dir()
    assert config.csv_dir.is_dir()
    assert json.loads((alpha_home / "config.json").read_text(encoding="utf-8")) == {
        "data_dir": str((alpha_home / "data").resolve())
    }


def test_config_round_trips_an_explicit_data_dir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """显式数据目录应原子保存并可重新加载。"""

    monkeypatch.setenv("TERAX_ALPHA_HOME", str(tmp_path / "alpha"))
    data_dir = tmp_path / "synced-data"

    save_config(AlphaConfig(data_dir=data_dir))

    assert load_config().data_dir == data_dir.resolve()


def test_config_rejects_relative_data_dir() -> None:
    """数据目录不得依赖 Alpha 进程当前工作目录。"""

    with pytest.raises(ValidationError, match="data_dir 必须是绝对路径"):
        AlphaConfig(data_dir=Path("relative-data"))


def test_config_rejects_unknown_fields() -> None:
    """未知配置字段应直接报错，避免拼写错误被静默忽略。"""

    with pytest.raises(ValidationError, match="extra_forbidden"):
        AlphaConfig.model_validate({"data_dir": str(Path.cwd()), "unknown": True})
