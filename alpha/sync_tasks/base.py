from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date

import pandas as pd


class BaseSyncProvider(ABC):
    """同步数据源抽象基类。"""

    @abstractmethod
    async def fetch_history(self, symbols: list[str], start_date: date, end_date: date, fields: str) -> pd.DataFrame:
        """批量获取历史行情并返回项目内部标准字段。

        该接口面向 ``BarSyncTask`` 的日线同步链路，返回结果应当已经完成
        数据源字段到项目内部字段的基础适配，调用方可以直接按统一字段消费，
        不应再依赖具体数据源的原始列名。

        Args:
            symbols: 数据源侧证券代码列表。当前 GM 数据源使用
                ``SHSE.600000``、``SZSE.000001`` 这类格式。
            start_date: 请求起始日期，闭区间。
            end_date: 请求结束日期，闭区间。
            fields: 透传给数据源接口的字段字符串。该参数主要用于约束远端
                返回列集合，但 provider 返回前仍需整理为项目内部统一字段。

        Returns:
            已按项目内部日线入库约定整理完成的 ``DataFrame``。至少包含：
            ``vt_symbol``、``symbol``、``exchange``、``datetime``、
            ``interval``、``adjust``、``volume``、``open``、``high``、
            ``low``、``close``、``turnover``、``open_interest``。

            其中 ``vt_symbol`` 必须符合数据库内部格式，例如 ``600000.SSE``；
            ``datetime`` 必须为 ``YYYY-MM-DD HH:MM:SS`` 字符串。
        """

    @abstractmethod
    async def fetch_history_symbol(self, symbol: str, start_date: date, end_date: date) -> pd.DataFrame:
        """获取单证券历史证券状态，并返回统一标准字段。

        该接口面向证券资料全量同步链路，输入使用数据源侧证券代码，例如
        GM 的 ``SHSE.600000``。provider 返回前必须完成从外部字段到项目
        内部证券状态字段的标准化，任务层不应再依赖数据源原始列名。

        Args:
            symbol: 数据源侧单证券代码。当前 GM provider 使用
                ``交易所.证券代码`` 格式，例如 ``SZSE.000001``。
            start_date: 请求起始日期，闭区间。
            end_date: 请求结束日期，闭区间。

        Returns:
            已标准化的 ``DataFrame``。字段应至少包含：
            ``gm_symbol``、``vt_symbol``、``asset_type``、``trade_date``、
            ``price_tick``、``trade_n``、``listed_date``、``delisted_date``、
            ``is_suspended``、``is_st``、``adj_factor``、``upper_limit``、
            ``lower_limit``。

            其中：
            - ``gm_symbol`` 为数据源原始代码；
            - ``vt_symbol`` 为数据库内部代码，例如 ``600000.SSE``；
            - ``trade_date``、``listed_date``、``delisted_date`` 使用
              ``YYYY-MM-DD`` 字符串；
            - 未退市证券的 ``delisted_date`` 应标准化为 ``None``；
            - ``upper_limit``、``lower_limit`` 仅对支持涨跌停价的证券可能有值；
            - 不适用或缺失字段允许为 ``None``。
        """

    @abstractmethod
    async def fetch_symbols_snapshot(self, asset_type: str, trade_date: date) -> pd.DataFrame:
        """获取单日多证券状态快照，并返回统一标准字段。

        该接口面向证券资料增量同步链路。provider 应在返回前完成字段标准化，
        返回列集合与 :meth:`fetch_history_symbol` 保持一致，便于任务层复用同一
        套装配逻辑。

        Args:
            asset_type: 项目内部资产类型，例如 ``stock``、``etf``、``index``。
            trade_date: 目标交易日。

        Returns:
            与 :meth:`fetch_history_symbol` 同构的标准化 ``DataFrame``。当数据源
            返回未知证券时，建议保留该行并令 ``vt_symbol`` 为空，由调用方决定
            是否跳过。
        """

    @abstractmethod
    async def fetch_index_constituents(self, index_symbol: str, trade_date: date) -> pd.DataFrame:
        """获取指数成分股。"""

    @abstractmethod
    async def fetch_trading_dates(self, exchange: str, start_year: int, end_year: int) -> pd.DataFrame | list:
        """获取交易日历。"""

    @abstractmethod
    async def fetch_symbol_infos(self, asset_type: str) -> pd.DataFrame:
        """获取证券静态资料，并返回统一标准字段。

        该接口仅用于低频离线初始化，例如刷新 universe/CSV 资源，定位与
        :meth:`fetch_trading_dates` 相同，不参与证券状态同步主链路。

        Args:
            asset_type: 项目内部资产类型，例如 ``stock``、``etf``、``index``。

        Returns:
            标准化后的静态证券资料 ``DataFrame``。建议与
            :meth:`fetch_history_symbol` / :meth:`fetch_symbols_snapshot`
            保持同构列集合；对于静态接口不存在的状态列，可填充 ``None``。
        """
