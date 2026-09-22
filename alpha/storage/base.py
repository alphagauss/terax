"""Alpha SQLite 表结构、分片规则和异步连接管理。"""

from __future__ import annotations

import asyncio
import os
import re
import sqlite3
import threading
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, TypeVar

from loguru import logger

ADJUST_FACTOR_CREATE = """
CREATE TABLE IF NOT EXISTS adjust_factor (
    vt_symbol TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    adj_factor REAL NOT NULL,
    PRIMARY KEY (vt_symbol, trade_date)
) WITHOUT ROWID;
"""

ADJUST_FACTOR_META_CREATE = """
CREATE TABLE IF NOT EXISTS adjust_factor_meta (
    vt_symbol TEXT NOT NULL PRIMARY KEY,
    latest_trade_date TEXT NOT NULL,
    last_sync_at TEXT NOT NULL
);
"""

BAR_OVERVIEW_CREATE = """
CREATE TABLE IF NOT EXISTS bar_overview (
    vt_symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (vt_symbol, interval)
) WITHOUT ROWID;
"""

SHARE_CAPITAL_CREATE = """
CREATE TABLE IF NOT EXISTS share_capital (
    vt_symbol TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    total_share REAL,
    float_share REAL,
    free_share REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (vt_symbol, trade_date)
) WITHOUT ROWID;
"""

SHARE_CAPITAL_META_CREATE = """
CREATE TABLE IF NOT EXISTS share_capital_meta (
    vt_symbol TEXT NOT NULL PRIMARY KEY,
    latest_trade_date TEXT NOT NULL,
    last_sync_at TEXT NOT NULL
);
"""

SECURITY_PROFILE_CREATE = """
CREATE TABLE IF NOT EXISTS security_profile (
    vt_symbol TEXT NOT NULL PRIMARY KEY,
    asset_type TEXT NOT NULL,
    board INTEGER,
    sec_name TEXT,
    sec_abbr TEXT,
    price_tick REAL,
    trade_n INTEGER,
    listed_date TEXT,
    delisted_date TEXT
);
"""

SECURITY_SUSPENDED_DAY_CREATE = """
CREATE TABLE IF NOT EXISTS security_suspended_day (
    vt_symbol TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    PRIMARY KEY (vt_symbol, trade_date)
) WITHOUT ROWID;
"""

SECURITY_ST_DAY_CREATE = """
CREATE TABLE IF NOT EXISTS security_st_day (
    vt_symbol TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    PRIMARY KEY (vt_symbol, trade_date)
) WITHOUT ROWID;
"""

SECURITY_STATUS_META_CREATE = """
CREATE TABLE IF NOT EXISTS security_status_meta (
    vt_symbol TEXT NOT NULL PRIMARY KEY,
    latest_checked_trade_date TEXT NOT NULL,
    latest_data_trade_date TEXT,
    is_terminal INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
"""

INDEX_CONSTITUENT_MEMBERSHIP_CREATE = """
CREATE TABLE IF NOT EXISTS index_constituent_membership (
    index_code TEXT NOT NULL,
    vt_symbol TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (index_code, vt_symbol, start_date)
) WITHOUT ROWID;
"""

INDEX_CONSTITUENT_META_CREATE = """
CREATE TABLE IF NOT EXISTS index_constituent_meta (
    index_code TEXT NOT NULL PRIMARY KEY,
    latest_trade_date TEXT NOT NULL,
    last_sync_at TEXT NOT NULL
);
"""

MAIN_DB_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS watchlist (
        vt_symbol TEXT NOT NULL PRIMARY KEY
    );""",
    ADJUST_FACTOR_CREATE,
    ADJUST_FACTOR_META_CREATE,
    BAR_OVERVIEW_CREATE,
    SHARE_CAPITAL_CREATE,
    SHARE_CAPITAL_META_CREATE,
    SECURITY_PROFILE_CREATE,
    SECURITY_SUSPENDED_DAY_CREATE,
    SECURITY_ST_DAY_CREATE,
    SECURITY_STATUS_META_CREATE,
    INDEX_CONSTITUENT_MEMBERSHIP_CREATE,
    INDEX_CONSTITUENT_META_CREATE,
]

BAR_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS bardata (
    vt_symbol TEXT NOT NULL,
    datetime TEXT NOT NULL,
    volume REAL NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    turnover REAL DEFAULT 0,
    open_interest REAL DEFAULT 0,
    upper_limit REAL DEFAULT 0,
    lower_limit REAL DEFAULT 0,
    PRIMARY KEY (vt_symbol, datetime)
) WITHOUT ROWID;
"""

BAR_SHARD_SCHEMA = [BAR_CREATE_SQL]

PARTITION_FILE_PATTERN = re.compile(
    r"^(?:tick_\d{4}_\d{2}_\d{2}|[A-Za-z0-9]+_\d{4}|[A-Za-z0-9]+_\d{4}_\d{2})\.db$"
)

T = TypeVar("T")
SQLiteOperation = Callable[[sqlite3.Connection], T]


class SQLiteStorageBase:
    """管理主库、分片库及其异步读写能力。"""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.bulk_import_mode = False
        self.main_db_path = self.data_dir.joinpath("main.db")
        self._write_locks: dict[str, threading.Lock] = {}
        self._opened_paths: set[Path] = set()
        self._initialize_database(self.main_db_path, MAIN_DB_SCHEMA)

    def set_bulk_import_mode(self, enabled: bool) -> None:
        """切换批量导入模式。

        新模式会应用到后续新建的写连接，不影响已结束的历史操作。
        """
        self.bulk_import_mode = enabled

    def get_partition_path(self, file_name: str) -> Path:
        """获取分片数据库路径，并确保写入前已完成建表。"""
        path = self.data_dir.joinpath(file_name)
        if not path.exists():
            self._initialize_database(path, BAR_SHARD_SCHEMA)
        return path

    def get_partition_name(self, interval: str, dt: datetime) -> str:
        """根据周期和时间推导分片文件名。"""
        if interval == "tick":
            return f"tick_{dt.year:04d}_{dt.month:02d}_{dt.day:02d}.db"
        if interval in {"d", "w"}:
            return f"{interval}_{dt.year:04d}.db"
        return f"{interval}_{dt.year:04d}_{dt.month:02d}.db"

    def iter_partition_names(
        self,
        interval: str,
        start: datetime,
        end: datetime,
    ) -> list[str]:
        """根据时间范围推导所需分片文件。"""
        file_names = list(self.iter_partition_names_reverse(interval, start, end))
        file_names.reverse()
        return file_names

    def iter_partition_names_reverse(
        self,
        interval: str,
        start: datetime,
        end: datetime,
    ) -> Iterator[str]:
        """从最新到最早惰性生成时间范围内的分片文件名。"""
        if end < start:
            return

        if interval == "tick":
            first = start.replace(hour=0, minute=0, second=0, microsecond=0)
            current = end.replace(hour=0, minute=0, second=0, microsecond=0)
            while current >= first:
                yield self.get_partition_name(interval, current)
                current -= timedelta(days=1)
            return

        if interval in {"d", "w"}:
            for year in range(end.year, start.year - 1, -1):
                yield f"{interval}_{year:04d}.db"
            return

        first = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        current = end.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        while current >= first:
            yield self.get_partition_name(interval, current)
            if current.month == 1:
                current = current.replace(year=current.year - 1, month=12, day=1)
            else:
                current = current.replace(month=current.month - 1, day=1)

    def list_partition_files(self) -> list[Path]:
        """列出所有符合规则的分片库文件。"""
        return sorted(
            [
                path
                for path in self.data_dir.glob("*.db")
                if path.name != "main.db" and PARTITION_FILE_PATTERN.match(path.name)
            ]
        )

    async def read_main(self, operation: SQLiteOperation[T]) -> T:
        """在主库上执行只读操作。"""
        return await self.read(self.main_db_path, operation)

    async def write_main(self, operation: SQLiteOperation[T]) -> T:
        """在主库上执行写操作。"""
        return await self.write(self.main_db_path, operation)

    async def read_partition(self, file_name: str, operation: SQLiteOperation[T]) -> T:
        """在指定分片库上执行只读操作。"""
        return await self.read(self.data_dir.joinpath(file_name), operation)

    async def write_partition(self, file_name: str, operation: SQLiteOperation[T]) -> T:
        """在指定分片库上执行写操作。"""
        path = self.get_partition_path(file_name)
        return await self.write(path, operation)

    async def read(self, path: Path, operation: SQLiteOperation[T]) -> T:
        """创建短生命周期只读连接并执行操作。"""
        return await asyncio.to_thread(self._run_read_operation, path, operation)

    async def write(self, path: Path, operation: SQLiteOperation[T]) -> T:
        """按数据库文件串行执行写操作。"""
        lock = self._get_write_lock(path)
        return await asyncio.to_thread(self._run_write_operation, path, operation, lock)

    def close(self) -> None:
        """关闭存储对象并清理已访问数据库的 WAL 辅助文件。"""
        try:
            self._cleanup_opened_database_sidecars()
        finally:
            self._write_locks.clear()
            self._opened_paths.clear()

    def _initialize_database(self, path: Path, schema_statements: list[str]) -> None:
        """初始化数据库文件与表结构。"""
        conn = self._open_connection(path, readonly=False)
        try:
            conn.executescript("".join(schema_statements))
            conn.commit()
        finally:
            conn.close()

    def _open_connection(self, path: Path, *, readonly: bool) -> sqlite3.Connection:
        """创建 SQLite 连接并设置常用参数。"""
        self._opened_paths.add(path.resolve())
        if readonly:
            conn = sqlite3.connect(self._build_read_uri(path), uri=True)
            conn.execute("PRAGMA query_only=ON;")
        else:
            conn = sqlite3.connect(str(path))
            conn.execute("PRAGMA journal_mode=WAL;")
            if self.bulk_import_mode:
                conn.execute("PRAGMA synchronous=OFF;")
                conn.execute("PRAGMA temp_store=MEMORY;")
                conn.execute("PRAGMA cache_size=-200000;")
            else:
                conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn

    def _run_read_operation(self, path: Path, operation: SQLiteOperation[T]) -> T:
        """在线程中执行只读数据库操作。"""
        conn = self._open_connection(path, readonly=True)
        try:
            return operation(conn)
        finally:
            conn.close()

    def _run_write_operation(
        self,
        path: Path,
        operation: SQLiteOperation[T],
        lock: threading.Lock,
    ) -> T:
        """在线程中执行写事务，并确保同一库文件串行。"""
        with lock:
            conn = self._open_connection(path, readonly=False)
            try:
                result = operation(conn)
                conn.commit()
                return result
            except Exception as exc:
                conn.rollback()
                logger.error("Error occurred while executing SQL on {}: {}", path, exc)
                raise
            finally:
                conn.close()

    def _get_write_lock(self, path: Path) -> threading.Lock:
        """获取指定数据库文件的写锁。"""
        key = str(path)
        existing = self._write_locks.get(key)
        if existing is not None:
            return existing

        lock = threading.Lock()
        self._write_locks[key] = lock
        return lock

    def _build_read_uri(self, path: Path) -> str:
        """构造 SQLite 只读连接 URI。"""
        return f"{path.resolve().as_uri()}?mode=ro"

    def check_size(self, path: Path) -> int:
        """返回指定数据库文件大小。"""
        return os.path.getsize(path)

    def _cleanup_opened_database_sidecars(self) -> None:
        """尽力清理已访问数据库遗留的 WAL/SHM 文件。

        处理策略：

        - 对仅遗留空 ``-wal`` 文件或孤立 ``-shm`` 文件的数据库，直接删除辅助文件；
        - 对仍存在非空 ``-wal`` 的数据库，先执行一次 ``wal_checkpoint(TRUNCATE)``，
          再尝试删除已经清空的辅助文件；
        - 若数据库仍被其他进程占用，则保留文件并记录日志，避免为了清理副文件
          强行改动主库状态。
        """
        for path in sorted(self._opened_paths):
            try:
                self._cleanup_database_sidecars(path)
            except Exception as exc:
                logger.warning("清理 SQLite 辅助文件失败 {}: {}", path, exc)

    def _cleanup_database_sidecars(self, path: Path) -> None:
        """清理单个数据库旁的 WAL/SHM 文件。"""
        if not path.exists():
            return

        wal_path = path.with_name(f"{path.name}-wal")
        shm_path = path.with_name(f"{path.name}-shm")
        wal_exists = wal_path.exists()
        shm_exists = shm_path.exists()
        if not wal_exists and not shm_exists:
            return

        wal_size = wal_path.stat().st_size if wal_exists else 0

        # 仅遗留空 WAL 或孤立 SHM 时，直接删除即可，避免无意义重新打开数据库。
        if wal_size == 0:
            self._remove_sidecar_file(wal_path, allow_non_empty=False)
            self._remove_sidecar_file(shm_path, allow_non_empty=True)
            return

        # 存在未截断 WAL 时，先做一次 checkpoint，再尝试移除已经释放的辅助文件。
        conn = sqlite3.connect(str(path))
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.commit()
        finally:
            conn.close()

        self._remove_sidecar_file(wal_path, allow_non_empty=False)
        self._remove_sidecar_file(shm_path, allow_non_empty=True)

    def _remove_sidecar_file(self, path: Path, *, allow_non_empty: bool) -> None:
        """按约束删除 SQLite 辅助文件。"""
        if not path.exists():
            return
        if not allow_non_empty and path.stat().st_size > 0:
            return
        path.unlink(missing_ok=True)
