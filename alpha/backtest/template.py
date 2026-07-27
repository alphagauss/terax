from datetime import date
from typing import TYPE_CHECKING
from collections import defaultdict
from datetime import datetime

from alpha.common.enums import Direction, Interval, Offset, OrderType
from alpha.common.schema_backtest import AccountData, HoldData
from alpha.common.schema_market import TickData
from alpha.common.schema_trade import ContractData, OrderData, OrderRequest, TradeData
from alpha.strategy.models import (
    SecurityDailyStateData,
    SecurityProfileData,
    SecuritySnapshotData,
)
from alpha.utils import virtual, round_to, floor_to

if TYPE_CHECKING:
    from alpha.strategy.engine import StrategyEngine

    # from .manager import StrategyManager


class StrategyTemplate:
    """Strategy template"""

    class_name: str = ""
    desc: str = ""

    def __init__(
        self,
        strategy_engine: "StrategyEngine",
        instance_name: str,  # 用来表示实例化后的策略名字
        vt_symbols: list[str],
        param_setting: dict,
    ) -> None:
        """
        Normally no need to call this __init__ when implementing a strategy.
        """
        self.strategy_engine: "StrategyEngine" = strategy_engine
        self.status_dict: dict = {}

        self.instance_name: str = instance_name
        self.vt_symbols: list[str] = vt_symbols

        # Strategy status variable
        self.inited: bool = False
        self.trading: bool = False
        self.logs: list[str] = []

        # self.pos_data: dict[str, int] = defaultdict(int)
        self.long_pos: dict[str, int] = defaultdict(int)
        self.short_pos: dict[str, int] = defaultdict(int)

        self.active_orderids: set[str] = set()

        # Initialize parameters and variables lists
        if not hasattr(self, "parameters"):
            self.parameters: list[str] = []  # 参数：用于修改调整回测参数和效果

        if not hasattr(self, "variables"):
            self.variables: list[str] = []  # 变量：用于记录策略运行状态

        self.variables = ["inited", "trading"] + self.variables

        # Update strategy setting
        self.update_setting(param_setting)

    def update_setting(self, param_setting: dict) -> None:
        """Update parameters from setting"""
        for name in self.parameters:
            if name in param_setting:
                setattr(self, name, param_setting[name])

    @classmethod
    def get_class_parameters(cls) -> dict:
        """Get strategy default parameters"""
        class_parameters: dict = {}
        for name in cls.parameters:
            class_parameters[name] = getattr(cls, name)
        return class_parameters

    def get_parameters(self) -> dict:
        """Get strategy object parameters"""
        strategy_parameters: dict = {}
        for name in self.parameters:
            strategy_parameters[name] = getattr(self, name)
        return strategy_parameters

    def get_variables(self) -> dict:
        """Get strategy object variables"""
        strategy_variables: dict = {}
        for name in self.variables:
            strategy_variables[name] = getattr(self, name)
        return strategy_variables

    def get_status(self) -> dict:
        """Get strategy status dict"""
        self.update_status()
        return self.status_dict

    def update_status(self) -> None:
        """Update strategy status dict"""
        self.status_dict = {
            "instance_name": self.instance_name,
            "vt_symbols": self.vt_symbols,
            "class_name": self.__class__.__name__,
            "desc": self.desc,
            "inited": self.inited,
            "trading": self.trading,
            "logs": self.logs,
            "long_pos": dict(self.long_pos),
            "short_pos": dict(self.short_pos),
            "parameters": self.get_parameters(),
            "variables": self.get_variables(),
            "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

    @virtual
    def on_init(self) -> None:
        """Callback when strategy is inited"""
        pass

    @virtual
    def on_start(self) -> None:
        """Callback when strategy is started"""
        pass

    @virtual
    def on_stop(self) -> None:
        """Callback when strategy is stoped"""
        pass

    @virtual
    def on_tick(self, tick: TickData) -> None:
        """Callback of tick data update"""
        pass

    @virtual
    def on_bars(self, bars: dict[str, dict]) -> None:
        """Callback of candle bar update"""
        pass

    @virtual
    def on_trade(self, trade: TradeData) -> None:
        """Callback of trade update"""
        pass

    @virtual
    def on_order(self, order: OrderData) -> None:
        """Callback of order update"""
        pass

    def update_trade(self, trade: TradeData) -> None:
        """Calculate strategy pos data before calling on_trade"""
        if trade.offset == Offset.OPEN:
            if trade.direction == Direction.LONG:  # 多头开仓
                self.long_pos[trade.vt_symbol] += trade.volume
            elif trade.direction == Direction.SHORT:  # 空头开仓
                self.short_pos[trade.vt_symbol] += trade.volume
        elif trade.offset == Offset.CLOSE:
            if trade.direction == Direction.LONG:  # 空头平仓
                self.short_pos[trade.vt_symbol] -= trade.volume
            elif trade.direction == Direction.SHORT:  # 多头平仓
                self.long_pos[trade.vt_symbol] -= trade.volume
        self.on_trade(trade)

    def update_order(self, order: OrderData) -> None:
        """Update active orderid set beforce calling on_order"""
        vt_orderid: str = order.vt_orderid

        if not order.is_active() and vt_orderid in self.active_orderids:
            self.active_orderids.remove(vt_orderid)

        self.on_order(order)

    def buy(self, vt_symbol: str, price: float, volume: float) -> str:
        """Send buy order 多头建仓"""
        return self.send_order(vt_symbol, Direction.LONG, Offset.OPEN, price, volume)

    def sell(self, vt_symbol: str, price: float, volume: float) -> str:
        """Send sell order 多头平仓"""
        return self.send_order(vt_symbol, Direction.SHORT, Offset.CLOSE, price, volume)

    def short(self, vt_symbol: str, price: float, volume: float) -> str:
        """Send short order 空头建仓"""
        return self.send_order(vt_symbol, Direction.SHORT, Offset.OPEN, price, volume)

    def cover(self, vt_symbol: str, price: float, volume: float) -> str:
        """Send cover order 空头平仓"""
        return self.send_order(vt_symbol, Direction.LONG, Offset.CLOSE, price, volume)

    # 根据比例建仓
    def buy_ratio(self, vt_symbol: str, ratio: float, price: float) -> str:
        """根据比例建仓
        ratio：账户总资金的比例
        """
        contract: ContractData = self.strategy_engine.get_contract(vt_symbol)
        currnet_account = self.get_hold()
        total = currnet_account.total
        usable = currnet_account.usable
        target = total * ratio
        if usable < target:
            target = usable
        volume = target / (contract.size * price) * 0.99
        volume: int = int(floor_to(volume, contract.size))
        if volume > 0:
            return self.buy(vt_symbol, price, volume)

    def send_order(
        self,
        vt_symbol: str,
        direction: Direction,
        offset: Offset,
        price: float,
        volume: float,
    ) -> str:
        """Send new order"""
        if not self.trading:
            return ""
        contract: ContractData = self.strategy_engine.get_contract(vt_symbol)
        if not contract:
            self.write_log(f"委托失败，找不到合约：{vt_symbol}")
            return ""

        # Round order price and volume to nearest incremental value
        price: float = round_to(price, contract.pricetick)
        volume: int = int(floor_to(volume, contract.size))

        order_request = OrderRequest(
            vt_symbol=contract.vt_symbol,
            direction=direction,
            offset=offset,
            order_type=OrderType.LIMIT,
            price=price,
            volume=volume,
            reference=f"{self.instance_name}",
        )

        vt_orderid: str = self.strategy_engine.send_order(order_request)
        self.active_orderids.add(vt_orderid)
        return vt_orderid

    def cancel_order(self, vt_orderid: str) -> None:
        """Cancel existing order"""
        if self.trading:
            self.strategy_engine.cancel_order(self, vt_orderid)

    def cancel_all(self) -> None:
        """Cancel all active orders"""
        for vt_orderid in list(self.active_orderids):
            self.cancel_order(vt_orderid)

    def get_long_pos(self, vt_symbol: str, hold_date: date) -> int:
        """获取指定合约的多头仓位"""
        return self.long_pos.get(vt_symbol, 0)

    def get_usable_long_pos(self, vt_symbol: str, query_date: date) -> int:
        """获取指定合约的可用仓位"""
        account = self.get_hold()
        if vt_symbol in account.long_hold:
            hold_data: HoldData = account.long_hold[vt_symbol]
            if query_date > account.update:
                return hold_data.hold_pos
            elif query_date == account.update:
                return hold_data.hold_pos - hold_data.frozen_pos
        return 0

    def get_short_pos(self, vt_symbol: str) -> int:
        """获取指定合约的空头仓位"""
        return self.short_pos.get(vt_symbol, 0)

    def write_log(self, msg: str) -> None:
        """Write log"""
        self.strategy_engine.write_log(msg, self)

    def get_contract(self, vt_symbol: str) -> ContractData:
        """获取合约信息"""
        return self.strategy_engine.get_contract(vt_symbol)
    
    def get_hold(self) -> AccountData:
        """获取账户持仓数据"""
        return self.strategy_engine.check_hold()

    def get_security_profile(self, vt_symbol: str) -> SecurityProfileData | None:
        """获取证券静态资料。

        Args:
            vt_symbol: 项目内部标准证券代码。

        Returns:
            证券静态资料；若未加载则返回 ``None``。
        """
        return self.strategy_engine.get_security_profile(vt_symbol)

    def get_security_state(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> SecurityDailyStateData | None:
        """获取指定交易日的证券状态。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前策略上下文日期。

        Returns:
            对应交易日的证券状态；若无数据则返回 ``None``。
        """
        return self.strategy_engine.get_security_state(vt_symbol, query_dt)

    def get_security_snapshot(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> SecuritySnapshotData:
        """获取证券状态快照。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前策略上下文日期。

        Returns:
            证券状态快照。
        """
        return self.strategy_engine.get_security_snapshot(vt_symbol, query_dt)

    def is_st(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool:
        """判断证券在指定交易日是否为 ST。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前策略上下文日期。

        Returns:
            若证券当日为 ST 返回 ``True``，否则返回 ``False``。
        """
        return self.strategy_engine.is_st(vt_symbol, query_dt)

    def is_suspended(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool:
        """判断证券在指定交易日是否停牌。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前策略上下文日期。

        Returns:
            若证券当日停牌返回 ``True``，否则返回 ``False``。
        """
        return self.strategy_engine.is_suspended(vt_symbol, query_dt)

    def get_price_limits(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> tuple[float | None, float | None]:
        """获取指定交易日的涨跌停价。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前策略上下文日期。

        Returns:
            ``(upper_limit, lower_limit)`` 形式的涨跌停价元组。
        """
        return self.strategy_engine.get_price_limits(vt_symbol, query_dt)

    def in_universe(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool | None:
        """判断证券在指定交易日是否位于证券池中。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前策略上下文日期。

        Returns:
            若当日证券池已加载，则返回是否在池中；否则返回 ``None``。
        """
        return self.strategy_engine.in_universe(vt_symbol, query_dt)

    def init_bars(self, days: int, interval: Interval) -> None:
        """向引擎申请策略初始化阶段需要的历史K线数据。"""
        self.strategy_engine.load_bars(self, days, interval)

    def put_event(self) -> None:
        """Put strategy UI update event"""
        if self.inited:
            self.strategy_engine.put_strategy_event(self)

    def sync_data(self) -> None:
        """Sync strategy data into files"""
        if self.trading:
            self.strategy_engine.sync_strategy_data(self)
