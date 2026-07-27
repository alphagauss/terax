"""Alpha 运行目录测试。

验证 Terax 注入的数据和日志路径按目录处理，不因路径后缀或当前工作目录改变。
"""

from pathlib import Path

from alpha.common.paths import get_config_path, get_data_dir, get_logs_dir


def test_injected_directories_may_contain_suffixes(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """带后缀的注入路径仍应创建为目录。"""

    data_dir = tmp_path / "alpha.data"
    logs_dir = tmp_path / "alpha.logs"
    monkeypatch.setenv("TERAX_ALPHA_DATA_DIR", str(data_dir))
    monkeypatch.setenv("TERAX_ALPHA_LOG_DIR", str(logs_dir))

    assert get_data_dir() == data_dir
    assert get_logs_dir() == logs_dir
    assert data_dir.is_dir()
    assert logs_dir.is_dir()
    assert get_config_path() == data_dir / "config.json"
