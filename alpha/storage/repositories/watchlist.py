"""自选分组与成员顺序；所有命令在单个事务内精确修改共享业务数据。"""

import sqlite3
from uuid import uuid4

from alpha.storage.base import SQLiteStorageBase


class WatchlistConflict(ValueError):
    """命令引用的分组或成员已改变，客户端应重新读取快照。"""


class WatchlistRepository:
    """全部自选使用保留组 all；分组成员不复制行情，置顶不破坏普通顺序。"""

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage

    @staticmethod
    def _snapshot(conn):
        conn.row_factory = sqlite3.Row
        if not conn.in_transaction:
            conn.execute("BEGIN")
        return {
            "groups": [
                dict(row)
                for row in conn.execute(
                    "SELECT id, name FROM watchlist_group ORDER BY rowid"
                )
            ],
            "items": [
                {**dict(row), "pinned": bool(row["pinned"])}
                for row in conn.execute(
                    """SELECT w.group_id, w.vt_symbol, w.position, w.pinned, w.pin_position,
                COALESCE(NULLIF(p.sec_name, ''), w.vt_symbol) AS name, p.price_tick
                FROM watchlist_member w LEFT JOIN security_profile p
                ON p.vt_symbol = w.vt_symbol ORDER BY w.position, w.vt_symbol"""
                )
            ],
        }

    async def snapshot(self):
        """一次读取全部关系，客户端仅派生当前分组的展示顺序。"""
        return await self.storage.read_main(self._snapshot)

    async def execute(self, command: dict):
        """执行相对位置及批量成员命令，不接受客户端整表覆盖。"""

        def operation(conn):
            conn.execute("BEGIN IMMEDIATE")
            action = command["action"]
            group = command.get("group_id", "all")
            symbols = list(dict.fromkeys(command.get("symbols", [])))

            def require_group(group_id):
                if (
                    group_id != "all"
                    and not conn.execute(
                        "SELECT 1 FROM watchlist_group WHERE id = ?", (group_id,)
                    ).fetchone()
                ):
                    raise WatchlistConflict("group_missing")

            def append(group_id, symbol):
                conn.execute(
                    """INSERT OR IGNORE INTO watchlist_member
                    (group_id, vt_symbol, position) VALUES (?, ?,
                    (SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist_member WHERE group_id = ?))""",
                    (group_id, symbol, group_id),
                )

            transfer = None
            require_group(group)
            if action == "create_group":
                conn.execute(
                    "INSERT INTO watchlist_group VALUES (?, ?)",
                    (uuid4().hex, command["name"]),
                )
            elif action in {"rename_group", "delete_group"}:
                if group == "all":
                    raise WatchlistConflict("reserved_group")
                if action == "rename_group":
                    conn.execute(
                        "UPDATE watchlist_group SET name = ? WHERE id = ?",
                        (command["name"], group),
                    )
                else:
                    conn.execute(
                        "DELETE FROM watchlist_member WHERE group_id = ?", (group,)
                    )
                    conn.execute("DELETE FROM watchlist_group WHERE id = ?", (group,))
            elif action == "add":
                for symbol in symbols:
                    append("all", symbol)
                    if group != "all":
                        append(group, symbol)
            elif action == "remove":
                for symbol in symbols:
                    if group == "all":
                        conn.execute(
                            "DELETE FROM watchlist_member WHERE vt_symbol = ?",
                            (symbol,),
                        )
                    else:
                        conn.execute(
                            "DELETE FROM watchlist_member WHERE group_id = ? AND vt_symbol = ?",
                            (group, symbol),
                        )
            elif action in {"copy", "move"}:
                target = command["target_group_id"]
                require_group(target)
                if (
                    target == group
                    or target == "all"
                    or (action == "move" and group == "all")
                ):
                    raise WatchlistConflict("invalid_target")
                members = [
                    row[0]
                    for row in conn.execute(
                        """SELECT vt_symbol FROM watchlist_member WHERE group_id = ?
                    ORDER BY pinned DESC, CASE WHEN pinned THEN pin_position ELSE position END, vt_symbol""",
                        (group,),
                    )
                ]
                selected = set(symbols)
                if not selected.issubset(members):
                    raise WatchlistConflict("member_missing")
                existing = {
                    row[0]
                    for row in conn.execute(
                        "SELECT vt_symbol FROM watchlist_member WHERE group_id = ?",
                        (target,),
                    )
                }
                transfer = {
                    "total": len(selected),
                    "existing": len(selected & existing),
                }
                for symbol in members:
                    if symbol not in selected:
                        continue
                    append(target, symbol)
                    if action == "move":
                        conn.execute(
                            "DELETE FROM watchlist_member WHERE group_id = ? AND vt_symbol = ?",
                            (group, symbol),
                        )
            elif action in {"pin", "reorder"}:
                symbol = symbols[0]
                row = conn.execute(
                    "SELECT pinned FROM watchlist_member WHERE group_id = ? AND vt_symbol = ?",
                    (group, symbol),
                ).fetchone()
                if row is None:
                    raise WatchlistConflict("member_missing")
                if action == "pin":
                    if bool(row[0]) == command["pinned"]:
                        return self._snapshot(conn)
                    conn.execute(
                        """UPDATE watchlist_member SET pinned = ?, pin_position =
                        (SELECT COALESCE(MAX(pin_position), -1) + 1 FROM watchlist_member WHERE group_id = ?)
                        WHERE group_id = ? AND vt_symbol = ?""",
                        (command["pinned"], group, group, symbol),
                    )
                else:
                    field = "pin_position" if row[0] else "position"
                    ordered = [
                        r[0]
                        for r in conn.execute(
                            f"SELECT vt_symbol FROM watchlist_member WHERE group_id = ? AND pinned = ? ORDER BY {field}, vt_symbol",
                            (group, row[0]),
                        )
                        if r[0] != symbol
                    ]
                    edge = command.get("edge")
                    if edge:
                        index = 0 if edge == "first" else len(ordered)
                    else:
                        anchor = command["anchor"]
                        if anchor not in ordered:
                            raise WatchlistConflict("anchor_missing")
                        index = ordered.index(anchor) + (command.get("side") == "after")
                    ordered.insert(index, symbol)
                    slots = [
                        r[0]
                        for r in conn.execute(
                            f"SELECT {field} FROM watchlist_member WHERE group_id = ? AND pinned = ? ORDER BY {field}",
                            (group, row[0]),
                        )
                    ]
                    conn.executemany(
                        f"UPDATE watchlist_member SET {field} = ? WHERE group_id = ? AND vt_symbol = ?",
                        [
                            (position, group, item)
                            for position, item in zip(slots, ordered)
                        ],
                    )
            result = self._snapshot(conn)
            if transfer is not None:
                result["transfer"] = transfer
            return result

        try:
            return await self.storage.write_main(operation)
        except sqlite3.IntegrityError as error:
            raise WatchlistConflict("duplicate_group") from error
