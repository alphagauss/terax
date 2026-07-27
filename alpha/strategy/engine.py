from datetime import date, datetime
from abc import ABC, abstractmethod

from alpha.common.enums import Interval
from alpha.common.schema_backtest import AccountData
from alpha.common.schema_trade import ContractData, OrderRequest
from alpha.strategy.models import (
    SecurityDailyStateData,
    SecurityProfileData,
    SecuritySnapshotData,
)

class StrategyEngine(ABC):
    """交易引擎抽象基类。

    约束策略运行时依赖的最小引擎能力，供回测、模拟和实盘引擎统一实现。
    """

    @abstractmethod
    def __init__(
        self,
    ) -> None:
        """初始化引擎实例。

        子类应在此完成必要状态初始化，但不应执行阻塞式外部操作。
        """

    @abstractmethod
    def close(self) -> None:
        """关闭引擎并释放资源。

        Returns:
            无返回值
        """

    @abstractmethod
    def send_order(self, order_request: OrderRequest) -> str:
        """发送订单请求。

        Args:
            order_request: 订单请求对象

        Returns:
            订单编号
        """

    @abstractmethod
    def cancel_order(self, strategy: object, vt_orderid: str) -> None:
        """撤销指定订单。

        Args:
            strategy: 发起撤单的策略实例
            vt_orderid: 全局订单编号

        Returns:
            无返回值
        """

    @abstractmethod
    def load_bars(self, strategy: object, days: int, interval: Interval) -> None:
        """加载策略初始化所需历史K线。

        Args:
            strategy: 发起请求的策略实例
            days: 需要回放的初始化天数
            interval: K线周期

        Returns:
            无返回值
        """

    @abstractmethod
    def write_log(self, msg: str, strategy: object | None = None) -> None:
        """写入日志。

        Args:
            msg: 日志内容
            strategy: 关联的策略实例，允许为空。

        Returns:
            无返回值
        """

    @abstractmethod
    def put_strategy_event(self, strategy: object) -> None:
        """推送策略状态变更事件。

        Args:
            strategy: 策略实例

        Returns:
            无返回值
        """

    @abstractmethod
    def sync_strategy_data(self, strategy: object) -> None:
        """同步策略数据到持久化介质。

        Args:
            strategy: 策略实例

        Returns:
            无返回值
        """

    @abstractmethod
    def get_contract(self, vt_symbol: str) -> ContractData:
        """获取单个合约信息。

        Args:
            vt_symbol: 全局合约代码

        Returns:
            合约信息对象

        Raises:
            KeyError: 合约不存在
        """

    @abstractmethod
    def check_hold(self) -> AccountData:
        """检查当前持仓与账户快照。

        Returns:
            当前账户快照
        """

    @abstractmethod
    def get_security_profile(self, vt_symbol: str) -> SecurityProfileData | None:
        """获取证券静态资料。

        Args:
            vt_symbol: 项目内部标准证券代码。

        Returns:
            证券静态资料；若未加载则返回 ``None``。
        """

    @abstractmethod
    def get_security_state(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> SecurityDailyStateData | None:
        """获取指定交易日的证券状态。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前引擎上下文日期。

        Returns:
            逐日证券状态；若无对应数据则返回 ``None``。
        """

    @abstractmethod
    def get_security_snapshot(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> SecuritySnapshotData:
        """获取证券静态资料与逐日状态组成的快照。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前引擎上下文日期。

        Returns:
            证券状态快照。
        """

    @abstractmethod
    def is_st(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool:
        """判断证券在指定交易日是否为 ST。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前引擎上下文日期。

        Returns:
            若证券当日为 ST 返回 ``True``，否则返回 ``False``。
        """

    @abstractmethod
    def is_suspended(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool:
        """判断证券在指定交易日是否停牌。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前引擎上下文日期。

        Returns:
            若证券当日停牌返回 ``True``，否则返回 ``False``。
        """

    @abstractmethod
    def get_price_limits(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> tuple[float | None, float | None]:
        """获取指定交易日的涨跌停价。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前引擎上下文日期。

        Returns:
            ``(upper_limit, lower_limit)`` 形式的涨跌停价元组。
        """

    @abstractmethod
    def in_universe(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool | None:
        """判断证券在指定交易日是否位于当前证券池中。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前引擎上下文日期。

        Returns:
            若当日证券池已加载，则返回是否在池中；否则返回 ``None``。
        """
