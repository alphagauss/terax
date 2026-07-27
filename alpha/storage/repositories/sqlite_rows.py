from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence
from typing import TypeAlias, cast

SQLiteValue: TypeAlias = str | int | float | bytes | bool | None
SQLiteRecord: TypeAlias = dict[str, SQLiteValue]


def fetchone_record(
    cur: sqlite3.Cursor,
    extra_fields: Mapping[str, SQLiteValue] | None = None,
) -> SQLiteRecord | None:
    """按游标字段名读取单行记录。

    Args:
        cur: 已执行查询语句的 SQLite 游标。
        extra_fields: 需要追加到结果行中的常量字段，例如分片表未持久化的
            ``interval``。

    Returns:
        查询无结果时返回 ``None``，否则返回字段名到原始 SQLite 值的映射。
    """

    row = cur.fetchone()
    if row is None:
        return None
    columns = _get_columns(cur)
    return _build_record(columns, row, extra_fields)


def fetchall_records(
    cur: sqlite3.Cursor,
    extra_fields: Mapping[str, SQLiteValue] | None = None,
) -> list[SQLiteRecord]:
    """按游标字段名读取多行记录。

    Args:
        cur: 已执行查询语句的 SQLite 游标。
        extra_fields: 需要追加到每行结果中的常量字段。

    Returns:
        字段名到原始 SQLite 值的映射列表。
    """

    columns = _get_columns(cur)
    return [_build_record(columns, row, extra_fields) for row in cur.fetchall()]


def _get_columns(cur: sqlite3.Cursor) -> tuple[str, ...]:
    """从游标说明中读取查询字段名。"""

    description = cur.description
    if description is None:
        return ()
    return tuple(column[0] for column in description)


def _build_record(
    columns: tuple[str, ...],
    row: Sequence[SQLiteValue],
    extra_fields: Mapping[str, SQLiteValue] | None,
) -> SQLiteRecord:
    """使用已缓存的字段名将单行元组映射为字典。"""

    if not columns:
        return dict(extra_fields or {})

    record = cast(SQLiteRecord, dict(zip(columns, row, strict=True)))
    if extra_fields is not None:
        record.update(extra_fields)
    return record
