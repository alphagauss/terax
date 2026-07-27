"""SQLite 数据库 VACUUM 维护工具。"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter


@dataclass(frozen=True)
class VacuumStats:
    """单个 SQLite 数据库 VACUUM 统计。"""

    db_path: Path
    before_size: int
    after_size: int
    elapsed_seconds: float

    @property
    def reclaimed_size(self) -> int:
        """返回回收空间字节数。

        Args:
            无。

        Returns:
            VACUUM 前后减少的字节数；不会小于 0。
        """

        return max(0, self.before_size - self.after_size)


def iter_sqlite_db_paths(
    sqlite_dir: Path,
    selected_names: set[str] | None = None,
) -> list[Path]:
    """列出待处理 SQLite 数据库文件。

    Args:
        sqlite_dir: SQLite 数据库目录。
        selected_names: 可选数据库文件名集合；为空时处理目录下全部 `.db` 文件。

    Returns:
        按文件名排序的数据库路径列表。

    Raises:
        FileNotFoundError: 指定文件名不存在。
    """

    db_paths = {
        path.name: path
        for path in sqlite_dir.glob("*.db")
        if path.is_file()
    }

    if selected_names is not None:
        missing_names = sorted(name for name in selected_names if name not in db_paths)
        if missing_names:
            raise FileNotFoundError(
                f"未找到指定 SQLite 数据库: {', '.join(missing_names)}"
            )
        return [db_paths[name] for name in sorted(selected_names)]

    return [db_paths[name] for name in sorted(db_paths)]


def vacuum_database(db_path: Path) -> VacuumStats:
    """对单个 SQLite 数据库执行 VACUUM。

    Args:
        db_path: SQLite 数据库路径。

    Returns:
        VACUUM 前后的文件大小与耗时统计。
    """

    before_size = db_path.stat().st_size
    started_at = perf_counter()

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("VACUUM")
        conn.commit()
    finally:
        conn.close()

    elapsed_seconds = perf_counter() - started_at
    after_size = db_path.stat().st_size
    return VacuumStats(
        db_path=db_path,
        before_size=before_size,
        after_size=after_size,
        elapsed_seconds=elapsed_seconds,
    )


def _format_bytes(size: int) -> str:
    """格式化字节数。

    Args:
        size: 字节数。

    Returns:
        便于阅读的容量字符串。
    """

    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.2f} KiB"
    return f"{size / 1024 / 1024:.2f} MiB"


def print_stats(stats: list[VacuumStats]) -> None:
    """打印 VACUUM 统计摘要。

    Args:
        stats: 单库 VACUUM 统计列表。

    Returns:
        无返回值。
    """

    total_reclaimed = 0
    for item in stats:
        total_reclaimed += item.reclaimed_size
        print(f"数据库: {item.db_path.name}")
        print(f"  原始大小: {_format_bytes(item.before_size)}")
        print(f"  当前大小: {_format_bytes(item.after_size)}")
        print(f"  回收空间: {_format_bytes(item.reclaimed_size)}")
        print(f"  耗时: {item.elapsed_seconds:.2f}s")

    print(f"处理数量: {len(stats)}")
    print(f"总回收空间: {_format_bytes(total_reclaimed)}")
