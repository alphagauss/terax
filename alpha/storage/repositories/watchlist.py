"""自选证券仓储，单项增删避免多个客户端相互覆盖整份列表。"""

from alpha.storage.base import SQLiteStorageBase


class WatchlistRepository:
    """在业务主库保存共享自选，不保存行情副本。"""

    def __init__(self, storage: SQLiteStorageBase) -> None:
        self.storage = storage

    async def list_items(self) -> list[dict[str, str]]:
        """按加入顺序批量读取证券名称，失效证券仍可显示和移除。"""
        return await self.storage.read_main(
            lambda conn: [
                {"vt_symbol": row[0], "name": row[1]}
                for row in conn.execute(
                    """SELECT w.vt_symbol, COALESCE(NULLIF(p.sec_name, ''), w.vt_symbol)
                    FROM watchlist w LEFT JOIN security_profile p
                    ON p.vt_symbol = w.vt_symbol ORDER BY w.rowid"""
                )
            ]
        )

    async def set_symbol(self, vt_symbol: str, included: bool) -> None:
        """幂等修改一个证券，不覆盖其他客户端的更新。"""

        def operation(conn):
            conn.execute(
                (
                    "INSERT OR IGNORE INTO watchlist (vt_symbol) VALUES (?)"
                    if included
                    else "DELETE FROM watchlist WHERE vt_symbol = ?"
                ),
                (vt_symbol,),
            )

        await self.storage.write_main(operation)
