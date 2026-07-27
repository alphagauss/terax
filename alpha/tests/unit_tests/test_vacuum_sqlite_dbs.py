from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest


def _load_script_module():
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "vacuum_sqlite_dbs.py"
    spec = importlib.util.spec_from_file_location("vacuum_sqlite_dbs", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载脚本模块: {script_path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _create_fragmented_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")

        # 先写入大记录，再删除一部分，制造可回收空间。
        payload = "x" * 4096
        conn.executemany(
            "INSERT INTO sample (payload) VALUES (?)",
            [(payload,) for _ in range(200)],
        )
        conn.commit()

        conn.execute("DELETE FROM sample WHERE id % 2 = 0")
        conn.commit()
    finally:
        conn.close()


def test_iter_sqlite_db_paths_filters_and_sorts(tmp_path: Path) -> None:
    module = _load_script_module()
    sqlite_dir = tmp_path / ".data" / "sqlite_db"
    sqlite_dir.mkdir(parents=True)

    (sqlite_dir / "b.db").write_text("", encoding="utf-8")
    (sqlite_dir / "a.db").write_text("", encoding="utf-8")
    (sqlite_dir / "ignore.db-wal").write_text("", encoding="utf-8")
    (sqlite_dir / "notes.txt").write_text("", encoding="utf-8")

    paths = module.iter_sqlite_db_paths(sqlite_dir)

    assert [path.name for path in paths] == ["a.db", "b.db"]


def test_iter_sqlite_db_paths_raises_for_missing_selected_name(tmp_path: Path) -> None:
    module = _load_script_module()
    sqlite_dir = tmp_path / ".data" / "sqlite_db"
    sqlite_dir.mkdir(parents=True)
    (sqlite_dir / "main.db").write_text("", encoding="utf-8")

    with pytest.raises(FileNotFoundError, match="missing.db"):
        module.iter_sqlite_db_paths(sqlite_dir, {"main.db", "missing.db"})


def test_vacuum_database_reclaims_space(tmp_path: Path) -> None:
    module = _load_script_module()
    db_path = tmp_path / "fragmented.db"
    _create_fragmented_db(db_path)
    before_size = db_path.stat().st_size

    stats = module.vacuum_database(db_path)

    assert stats.db_path == db_path
    assert stats.before_size == before_size
    assert stats.after_size <= before_size
    assert stats.reclaimed_size > 0


def test_print_stats_outputs_summary(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    module = _load_script_module()
    stats = module.VacuumStats(
        db_path=tmp_path / "main.db",
        before_size=2048,
        after_size=1024,
        elapsed_seconds=1.25,
    )

    module.print_stats([stats])
    captured = capsys.readouterr()

    assert "数据库: main.db" in captured.out
    assert "处理数量: 1" in captured.out
    assert "总回收空间:" in captured.out
