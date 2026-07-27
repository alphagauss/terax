from collections import defaultdict
from datetime import date, datetime
from typing import Callable, Literal
import traceback
from pandas import DataFrame

from alpha.backtest.data import (
    BacktestInput,
)
from alpha.backtest.template import StrategyTemplate
from alpha.strategy.engine import StrategyEngine
from alpha.strategy.models import (
    SecurityDailyStateData,
    SecurityProfileData,
    SecuritySnapshotData,
)
from alpha.backtest.portfolio import PortfolioManager
from alpha.common.enums import Direction, Interval, Offset, OrderType, Status
from alpha.common.schema_backtest import AccountData
from alpha.common.schema_trade import ContractData, OrderData, OrderRequest, TradeData


class BackTesting(StrategyEngine):
    """同步回测引擎。"""

    gateway_name: str = "BACKTESTING"

    def __init__(self) -> None:
        """初始化回测引擎。"""
        self.contracts: dict[str, ContractData] = {}  # gao {vt_symbol, ContractData}

        self.start: datetime  # 回测开始时间
        self.end: datetime  # 回测结束时间

        self.risk_free: float = 0  # 无风险利率 (年化)
        self.annual_days: int = 240  # 年化交易日数量

        self.strategy_class: StrategyTemplate = (
            None  # 策略类，用于多进程、以及策略优化时使用
        )
        self.strategy_instance_name: str = ""  # 策略实例名称
        self.strategy: StrategyTemplate  # 策略实例
        self.datetime: datetime | None = None  # 当前回测引擎的内部时间

        self.interval: Interval  # K线周期
        self.price_adjust: Literal["pre", "post", "non"] = "pre"  # 回测使用的价格视图
        self.days: int = 0  # 策略初始化所需的天数 (用于加载足够数据)
        self.history_data: dict[datetime, dict[str, dict[str, object]]] = defaultdict(
            dict
        )  # 历史K线数据 {datetime: {vt_symbol: BarData}}
        self.security_profiles: dict[str, SecurityProfileData] = {}
        self.security_states_by_date: dict[date, dict[str, SecurityDailyStateData]] = {}
        self.universe_by_date: dict[date, set[str]] = {}
        self.bars: dict[str, dict[str, object]] = defaultdict(dict)  # 最新K线数据 {vt_symbol: dict}
        self.tested_days: list[date] = []  # 已回测的日期
        self.daily_close_bars: dict[date, dict[str, dict[str, object]]] = defaultdict(
            dict
        )  # 每日收盘的K线数据 {date: {vt_symbol: bar_dict}}

        self.order_count: int = 0  # 订单计数器

        self.logs: list = []  # 日志记录
        self.output: Callable[[object], None] = self._default_output  # 回测日志输出函数
        self.failed: bool = False  # 本轮回测是否失败
        self.error: str | None = None  # 本轮回测错误堆栈

        self.daily_df: DataFrame = None  # 每日盈亏的DataFrame

        # 订单管理
        self.limit_orders: dict[str, OrderData] = {}  # {vt_orderid: 订单}
        self.active_limit_orders: dict[str, OrderData] = {}  # {vt_orderid: 订单}

        # 成交单管理
        self.trade_count: int = 0  # 成交计数器
        self.trades: dict[str, TradeData] = {}  # 所有成交记录 {vt_tradeid: TradeData}

        self.capital: float = 1_000_000  # 初始资金
        self.portfolio = PortfolioManager(self, self.capital)

    def close(self) -> None:
        """关闭回测引擎。"""
        return

    def set_parameters(
        self,
        interval: Interval,
        start: datetime,
        end: datetime,
        capital: int,
        price_adjust: Literal["pre", "post", "non"] = "pre",
        risk_free: float = 0,
        annual_days: int = 240,
    ) -> None:
        """设置回测参数。

        Args:
            interval: K 线周期。
            start: 回测开始时间。
            end: 回测结束时间。
            capital: 初始资金。
            price_adjust: 价格复权方式。
            risk_free: 年化无风险利率。
            annual_days: 年化交易日数量。

        Returns:
            无返回值。
        """
        self.interval = interval
        self.start = start
        self.end = end
        self.capital = capital
        self.price_adjust = price_adjust
        self.portfolio.reset(capital)

        self.risk_free = risk_free
        self.annual_days = annual_days

    def load_input(self, data: BacktestInput) -> None:
        """装入已归一化的回测输入。

        Args:
            data: 回测输入数据，由数据装载层负责从数据库或测试夹具构造。

        Returns:
            无返回值。
        """

        self.contracts = dict(data.contracts)
        self.history_data = data.history_data
        self.security_profiles = dict(data.security_profiles)
        self.security_states_by_date = data.security_states_by_date
        self.universe_by_date = data.universe_by_date

    def add_strategy(
        self,
        strategy_class: type,
        instance_name: str,
    ) -> None:
        """添加策略类。

        Args:
            strategy_class: 策略类。
            instance_name: 策略实例名称。

        Returns:
            无返回值。
        """
        self.strategy_class = strategy_class
        self.strategy_instance_name = instance_name

    def run_backtesting(
        self,
        param_setting: dict,
    ) -> None:
        """开始运行回测"""
        if self.start >= self.end:
            raise Exception("起始日期必须小于结束日期")
        if not self.history_data:
            raise Exception("历史数据未装入，无法开始回测")

        self.trade_count = 0
        self.order_count = 0
        self.trades.clear()
        self.limit_orders.clear()
        self.active_limit_orders.clear()
        self.tested_days.clear()
        self.daily_close_bars.clear()
        self.datetime = None
        self.daily_df = None
        self.portfolio.reset(self.capital)
        self.failed = False
        self.error = None

        # 运行回测时再进行实例化
        self.strategy = self.strategy_class(
            self,  # 引擎实例，这里为回测引擎
            self.strategy_instance_name,  # 策略实例名称
            list(self.contracts.keys()),  # 策略交易的合约列表
            param_setting,  # 策略参数
        )
        self.write_strategy_logs(
            f"策略实例化完成，合约数量{len(self.contracts)}，时间切片数{len(self.history_data)}"
        )

        self.strategy.on_init()  # 调用策略的初始化方法

        # 按时间顺序回放(已去重并排序)
        dts: list[datetime] = sorted(self.history_data.keys())

        # 初始化策略 (例如计算指标需要一定前期数据)
        day_count: int = 0
        replay_start_ix: int = 0

        if self.days > 0:
            replay_start_ix = len(dts)
            for ix, dt in enumerate(dts):
                if self.datetime and dt.day != self.datetime.day:
                    day_count += 1
                    if day_count >= self.days:  # self.days 是策略初始化所需的天数
                        replay_start_ix = ix
                        break
                try:
                    self._new_bars(dt)
                except Exception:
                    self.failed = True
                    self.error = traceback.format_exc()
                    self.write_strategy_logs("策略初始化触发异常，回测终止")
                    self.write_strategy_logs(self.error)
                    return

        self.strategy.inited = True
        self.write_strategy_logs("策略初始化完成")

        self.strategy.on_start()
        self.strategy.trading = True
        self.write_strategy_logs("开始回放历史数据进行交易模拟。")

        # 使用剩余的数据进行回放和交易
        for dt in dts[replay_start_ix:]:
            try:
                self._new_bars(dt)
            except Exception:
                self.failed = True
                self.error = traceback.format_exc()
                self.write_strategy_logs("策略回测触发异常，回测终止")
                self.write_strategy_logs(self.error)
                return

        self.write_strategy_logs("历史数据回放结束, 策略结束")
        self.strategy.update_status()
        self.strategy.on_stop()
        self.strategy.trading = False

    def _new_bars(self, dt: datetime) -> None:
        """New bars update"""
        self.datetime = dt  # 更新引擎当前时间
        self.bars: dict[str, dict] = self.history_data[dt]

        if dt.date() not in self.tested_days:
            self.tested_days.append(dt.date())
        self.daily_close_bars[dt.date()] = self.bars

        self._cross_limit_order(self.bars)

        if self.strategy.inited:
            self._update_account(self.bars, dt)
        self.strategy.on_bars(self.bars)

    def _cross_limit_order(self, bars: dict[str, dict]) -> None:
        """
        检查并成交所有限价单
        """
        for order in list(self.active_limit_orders.values()):
            bar: dict | None = bars.get(order.vt_symbol, None)
            if not bar:
                self.write_log("当前bars下无法成交")
                continue

            # 更新订单状态
            if order.status == Status.SUBMITTING:
                order.status = Status.NOTTRADED
                self.strategy.update_order(order)

            upper_limit, lower_limit = self.get_price_limits(order.vt_symbol)
            if (
                (upper_limit is not None and order.price > upper_limit)
                or (lower_limit is not None and order.price < lower_limit)
            ):
                order.status = Status.REJECTED
                self.write_log(f"{order.vt_symbol} 委托价格超出当日涨跌停范围，委托拒绝")
                self.strategy.update_order(order)
                self.active_limit_orders.pop(order.vt_orderid, None)
                continue

            # 市价单，以开始价成交
            if order.order_type == OrderType.MARKET:
                trade_price = bar["open"]
            # 限价单，以指定价格成交
            elif order.order_type == OrderType.LIMIT:
                long_cross_price: float = bar["low"]
                short_cross_price: float = bar["high"]

                # Check if order can be crossed
                long_cross: bool = (
                    order.direction == Direction.LONG
                    and order.price >= long_cross_price
                    and long_cross_price > 0
                )
                short_cross: bool = (
                    order.direction == Direction.SHORT
                    and order.price <= short_cross_price
                    and short_cross_price > 0
                )
                if not long_cross and not short_cross:
                    continue
                trade_price = order.price
            # 其他类型的订单待需要时实现
            else:
                continue

            # 平仓时，需要检查账户中是否有足够的持仓平仓，没有则不成交
            if order.offset == Offset.CLOSE:
                if order.direction == Direction.LONG:
                    if not self.portfolio.can_close(
                        order.vt_symbol, order.direction, order.volume
                    ):
                        order.status = Status.REJECTED
                elif order.direction == Direction.SHORT:
                    if not self.portfolio.can_close(
                        order.vt_symbol, order.direction, order.volume
                    ):
                        order.status = Status.REJECTED

                if order.status == Status.REJECTED:
                    self.strategy.update_order(order)
                    self.active_limit_orders.pop(order.vt_orderid, None)
                    continue

            # 更新订单状态，并通知
            order.traded_volume = order.volume
            order.status = Status.ALLTRADED
            self.strategy.update_order(order)
            self.active_limit_orders.pop(order.vt_orderid)

            # 创建交易记录
            self.trade_count += 1
            trade: TradeData = TradeData(
                vt_symbol=order.vt_symbol,
                orderid=order.orderid,
                tradeid=str(self.trade_count),
                direction=order.direction,
                offset=order.offset,
                price=trade_price,
                volume=order.volume,
                datetime=self.datetime,
                gateway_name=self.gateway_name,
            )

            self.trades[trade.vt_tradeid] = trade
            self.strategy.update_trade(trade)
            self.update_position(trade)

    def load_bars(self, strategy: StrategyTemplate, days: int, interval: Interval) -> None:
        """策略调用，初始化数据"""
        self.days = days

    def update_position(self, trade: TradeData = None):
        """
        持仓监控和盈亏更新，每次交易数据更新时累积计算盈亏。
        """
        if trade:
            self.portfolio.update_position(trade)

    def _update_account(self, bars: dict[str, dict], dt: datetime) -> None:
        """逐bar更新账户持仓价值"""
        day: date = dt.date()
        pre_day: date | None = self.tested_days[-2] if len(self.tested_days) > 1 else None
        self.portfolio.update_account(bars, day, pre_day)

    def get_daily_result(self) -> list[dict]:
        """获取逐日盯市盈亏数据"""
        return self.portfolio.get_daily_result()

    def calculate_result(self) -> DataFrame | None:
        """Calculate daily marking-to-market PnL"""
        self.output("开始计算逐日盯市盈亏")

        rows = self.get_daily_result()
        if not rows:
            self.output("成交记录为空，无法计算")
            return None

        df: DataFrame = DataFrame(rows).sort_values("date").set_index("date")
        self.daily_df = df

        self.output("逐日盯市盈亏计算完成")
        return self.daily_df

    # =================用于strategy模板调用的方法===================

    def get_all_trades(self) -> list[TradeData]:
        """Get all trade data"""
        return list(self.trades.values())

    def get_all_orders(self) -> list[OrderData]:
        """Get all order data"""
        return list(self.limit_orders.values())

    # def get_history_data(self) -> list[dict]: # by gauss
    #     """获取本次回测中的k线数据（多合约）"""
    #     return list(self.history_data.values())

    def get_account_available(self) -> float:
        """获取当前可用资金"""
        return self.portfolio.usable

    def get_contract(self, vt_symbol: str) -> ContractData:
        """获取合约信息"""
        return self.contracts[vt_symbol]

    def get_security_profile(self, vt_symbol: str) -> SecurityProfileData | None:
        """获取证券静态资料。

        Args:
            vt_symbol: 项目内部标准证券代码。

        Returns:
            证券静态资料；若未加载则返回 ``None``。
        """
        return self.security_profiles.get(vt_symbol)

    def get_security_state(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> SecurityDailyStateData | None:
        """获取指定交易日的证券状态。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前回测时间。

        Returns:
            对应交易日的证券状态；若无数据则返回 ``None``。
        """
        resolved_date = self._resolve_query_date(query_dt)
        if resolved_date is None:
            return None
        return self.security_states_by_date.get(resolved_date, {}).get(vt_symbol)

    def get_security_snapshot(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> SecuritySnapshotData:
        """获取证券静态资料与逐日状态组成的快照。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前回测时间。

        Returns:
            证券状态快照。
        """
        resolved_date = self._resolve_query_date(query_dt)
        in_universe = None if resolved_date is None else self.in_universe(vt_symbol, resolved_date)
        return SecuritySnapshotData(
            profile=self.get_security_profile(vt_symbol),
            daily_state=self.get_security_state(vt_symbol, resolved_date),
            in_universe=in_universe,
        )

    def is_st(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool:
        """判断证券在指定交易日是否为 ST。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前回测时间。

        Returns:
            若证券当日为 ST 返回 ``True``，否则返回 ``False``。
        """
        state = self.get_security_state(vt_symbol, query_dt)
        return False if state is None else state.is_st

    def is_suspended(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool:
        """判断证券在指定交易日是否停牌。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前回测时间。

        Returns:
            若证券当日停牌返回 ``True``，否则返回 ``False``。
        """
        state = self.get_security_state(vt_symbol, query_dt)
        return False if state is None else state.is_suspended

    def get_price_limits(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> tuple[float | None, float | None]:
        """获取指定交易日的涨跌停价。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前回测时间。

        Returns:
            ``(upper_limit, lower_limit)`` 形式的涨跌停价元组。
        """
        state = self.get_security_state(vt_symbol, query_dt)
        if state is None:
            return None, None
        return state.upper_limit, state.lower_limit

    def in_universe(
        self,
        vt_symbol: str,
        query_dt: date | datetime | None = None,
    ) -> bool | None:
        """判断证券在指定交易日是否位于证券池中。

        Args:
            vt_symbol: 项目内部标准证券代码。
            query_dt: 查询交易日；为空时使用当前回测时间。

        Returns:
            若当日证券池已加载，则返回是否在池中；否则返回 ``None``。
        """
        resolved_date = self._resolve_query_date(query_dt)
        if resolved_date is None:
            return None
        if resolved_date not in self.universe_by_date:
            return None
        return vt_symbol in self.universe_by_date[resolved_date]

    def _resolve_query_date(
        self,
        query_dt: date | datetime | None,
    ) -> date | None:
        """把查询时间解析为交易日，并阻止未来日期访问。"""
        if query_dt is None:
            resolved_date = None if self.datetime is None else self.datetime.date()
        elif isinstance(query_dt, datetime):
            resolved_date = query_dt.date()
        else:
            resolved_date = query_dt

        current_date = None if self.datetime is None else self.datetime.date()
        if (
            resolved_date is not None
            and current_date is not None
            and resolved_date > current_date
        ):
            raise ValueError(f"回测上下文不允许查询未来交易日: {resolved_date.isoformat()}")

        return resolved_date

    def send_order(self, order_request: OrderRequest) -> str:
        """生成orderid, 更新账户中的order字典"""
        self.order_count += 1
        orderid: str = f"bt_{self.order_count}"
        order: OrderData = order_request.create_order_data(orderid, "backtest")
        self.active_limit_orders[order.vt_orderid] = order
        self.limit_orders[order.vt_orderid] = order
        return orderid

    def cancel_order(self, strategy: StrategyTemplate, vt_orderid: str) -> None:
        """Cancel existing order"""
        if vt_orderid not in self.active_limit_orders:
            return
        order: OrderData = self.active_limit_orders.pop(vt_orderid)

        order.status = Status.CANCELLED
        self.strategy.update_order(order)

    def write_log(self, msg: str, strategy: StrategyTemplate = None) -> None:
        """Write log message"""
        msg: str = f"{self.datetime}\t{msg}"
        self.logs.append(msg)
        self.output(msg)

    def sync_strategy_data(self, strategy: StrategyTemplate) -> None:
        """Sync strategy data into file"""
        pass

    def put_strategy_event(self, strategy: StrategyTemplate) -> None:
        """Put strategy UI update event"""
        pass

    def _default_output(self, msg: object) -> None:
        """Output backtesting engine message"""
        msg = f"{datetime.now()}\t{msg}"
        print(msg)

    def write_strategy_logs(self, msg: str) -> None:
        """Write strategy log message"""
        msg: str = f"{datetime.now()}\t{msg}"
        self.strategy.logs.append(msg)
        self.output(msg)

    def check_hold(self) -> AccountData:
        """检查持仓"""
        if not self.tested_days:
            return AccountData(update=date.today())

        account = self.portfolio.daily_account.get(self.tested_days[-1], None)
        if account:
            return account

        if len(self.tested_days) > 1:
            account = self.portfolio.daily_account.get(self.tested_days[-2], None)
            if account:
                return account

        return AccountData(update=self.tested_days[-1])
