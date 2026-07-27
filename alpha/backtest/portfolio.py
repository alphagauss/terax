from __future__ import annotations

from collections import defaultdict
from datetime import date

from alpha.strategy.engine import StrategyEngine
from alpha.common.enums import Direction, Offset
from alpha.common.schema_backtest import AccountData, HoldData
from alpha.common.schema_trade import ContractData, TradeData


class PortfolioManager:
    """Manage positions and account state for backtesting."""

    def __init__(self, engine: StrategyEngine, capital: float = 0) -> None:
        self.engine: StrategyEngine = engine  # 通过抽象引擎获取合约信息

        self.long_avg_cost: dict[str, float] = defaultdict(float)  # 多头持仓均价
        self.short_avg_cost: dict[str, float] = defaultdict(float)  # 空头持仓均价
        self.long_pos: dict[str, float] = defaultdict(float)  # 多头持仓数量
        self.short_pos: dict[str, float] = defaultdict(float)  # 空头持仓数量
        self.long_profit: dict[str, float] = defaultdict(float)  # 多头浮动盈亏
        self.short_profit: dict[str, float] = defaultdict(float)  # 空头浮动盈亏

        self.daily_account: dict[date, AccountData] = {}  # 逐日账户快照
        self.daily_long_hold: dict[date, dict[str, HoldData]] = defaultdict(dict)  # 逐日多头持仓
        self.daily_shorthold: dict[date, dict[str, HoldData]] = defaultdict(dict)  # 逐日空头持仓

        self.capital: float = 0  # 初始资金
        self.total: float = 0  # 账户总资产
        self.usable: float = 0  # 账户可用资金
        self.realized_pnl: float = 0  # 已实现盈亏
        self.frozen: float = 0  # 冻结资金（持仓占用）
        self.total_slippage: float = 0  # 累计滑点
        self.total_commission: float = 0  # 累计手续费

        self.reset(capital)

    def reset(self, capital: float) -> None:
        """重置组合状态并设置初始资金。"""
        self.capital = capital
        self.total = capital
        self.usable = capital
        self.realized_pnl = 0
        self.frozen = 0
        self.total_slippage = 0
        self.total_commission = 0

        self.long_avg_cost.clear()
        self.short_avg_cost.clear()
        self.long_pos.clear()
        self.short_pos.clear()
        self.long_profit.clear()
        self.short_profit.clear()
        self.daily_account.clear()
        self.daily_long_hold.clear()
        self.daily_shorthold.clear()

    def can_close(self, vt_symbol: str, direction: Direction, volume: float) -> bool:
        """Offset.CLOSE时，检查是否有足够持仓用于平仓。"""
        if direction == Direction.LONG: # 空头平仓
            return self.short_pos[vt_symbol] >= volume
        return self.long_pos[vt_symbol] >= volume # 多头平仓

    def update_position(self, trade: TradeData) -> None:
        """根据成交更新仓位、交易成本、已实现盈亏与可用资金。"""
        # 滑点和手续费的新的计算方式：开仓时，将其算在持仓成本中；平仓时，将其算在平仓盈亏中，不在单独列出
        if not trade or trade.volume <= 0:
            return

        vt_symbol = trade.vt_symbol
        trade_day = trade.datetime.date()

        today_account = self.daily_account.setdefault(trade_day, AccountData(update=trade_day))
        today_long_hold = self.daily_long_hold.setdefault(trade_day, {})

        # 获取合约信息
        contract: ContractData = self.engine.get_contract(vt_symbol)
        turnover: float = trade.volume * trade.price * contract.size
        slippage: float = trade.volume * contract.size * contract.slippage
        commission: float = turnover * contract.rate
        trade.update_cost(slippage, commission)

        # 更新仓位
        if trade.offset == Offset.OPEN:
            # 多头开仓
            if trade.direction == Direction.LONG:
                old_cost = self.long_avg_cost[vt_symbol] * self.long_pos[vt_symbol] * contract.size
                self.long_pos[vt_symbol] += trade.volume
                if self.long_pos[vt_symbol] > 0:
                    self.long_avg_cost[vt_symbol] = (
                        old_cost + turnover + slippage + commission
                    ) / (self.long_pos[vt_symbol] * contract.size)

                # 股票多头需要更新冻结的仓位及均价，其他的在bar更新时再更新
                hold_data = today_long_hold.setdefault(
                    vt_symbol, HoldData(vt_symbol=vt_symbol, direction=Direction.LONG)
                )
                old_frozen_cost = hold_data.frozen_pos * hold_data.frozen_price * contract.size
                hold_data.frozen_pos += trade.volume
                hold_data.frozen_price = (
                    old_frozen_cost + turnover + slippage + commission
                ) / (hold_data.frozen_pos * contract.size)

            # Offset.OPEN + Direction.SHORT 是空头开仓
            elif trade.direction == Direction.SHORT:
                # 空头开仓：如果是保证金交易，冻结保证金；如果是现货做空，冻结对应市值
                old_cost = self.short_avg_cost[vt_symbol] * self.short_pos[vt_symbol] * contract.size
                self.short_pos[vt_symbol] += trade.volume
                if self.short_pos[vt_symbol] > 0:
                    self.short_avg_cost[vt_symbol] = (
                        old_cost + turnover + slippage + commission
                    ) / (self.short_pos[vt_symbol] * contract.size)

        elif trade.offset == Offset.CLOSE: # 平仓
            pnl = 0.0
            # 平仓时计算已实现盈亏
            if trade.direction == Direction.LONG:
                # Offset.CLOSE + Direction.LONG 平空头仓位
                released_frozen = self.short_avg_cost[vt_symbol] * trade.volume * contract.size
                pnl = released_frozen - turnover - commission - slippage
                self.short_pos[vt_symbol] -= trade.volume
                if self.short_pos[vt_symbol] == 0:
                    self.short_avg_cost[vt_symbol] = 0

            elif trade.direction == Direction.SHORT:
                # Offset.CLOSE + Direction.SHORT  平多头仓位
                released_frozen = self.long_avg_cost[vt_symbol] * trade.volume * contract.size
                pnl = turnover - released_frozen - commission - slippage
                self.long_pos[vt_symbol] -= trade.volume
                if self.long_pos[vt_symbol] == 0:
                    self.long_avg_cost[vt_symbol] = 0
                
                # 股票多头平仓需要记录盈亏，避免无持仓时丢失数据，其他的在bar更新时再更新
                hold_data = today_long_hold.setdefault(
                    vt_symbol, HoldData(vt_symbol=vt_symbol, direction=Direction.LONG)
                )
                hold_data.hold_earn += pnl # 持仓盈亏，加上已实现盈亏

            self.realized_pnl += pnl
            today_account.day_earn += pnl

        today_account.commission += commission
        today_account.slippage += slippage
        today_account.turnover += turnover
        today_account.trade_count += 1

        self.total_slippage += slippage
        self.total_commission += commission

        # 计算当前持仓占用的资金（只计算多头持仓占用的资金）
        frozen_capital = 0.0
        for vt_symbol, pos in self.long_pos.items():
            if pos > 0:
                contract: ContractData = self.engine.get_contract(vt_symbol)
                frozen_capital += pos * self.long_avg_cost[vt_symbol] * contract.size

        # 空头持仓不占用现金资金（做空是卖出操作，释放资金）
        self.frozen = frozen_capital

        # 更新可用资金
        # 平仓盈亏里面已经包含了平仓的手续费和滑点
        # 开仓冻结的资金里面已经包含了开仓的手续费和滑点
        self.usable = self.capital + self.realized_pnl - self.frozen

    def update_account(self, bars: dict[str, dict], day: date, pre_day: date | None) -> None:
        """按当前bar盯市，更新浮动盈亏、总资产和当日账户快照。"""
        today_long_hold = self.daily_long_hold.setdefault(day, {})
        today_shorthold = self.daily_shorthold.setdefault(day, {})

        # 计算未实现盈亏,需要每日更新,以及更新每日仓位信息
        for vt_symbol, pos in self.long_pos.items():
            if pos > 0:
                last_price = bars[vt_symbol]["close"]
                contract: ContractData = self.engine.get_contract(vt_symbol)

                # 多头的持仓盈亏
                self.long_profit[vt_symbol] = (
                    (last_price - self.long_avg_cost[vt_symbol]) * self.long_pos[vt_symbol] * contract.size
                )

                # 更新每日持仓
                hold_data = today_long_hold.setdefault(
                    vt_symbol, HoldData(vt_symbol=vt_symbol, direction=Direction.LONG)
                )
                hold_data.hold_pos = self.long_pos[vt_symbol]
                hold_data.price = self.long_avg_cost[vt_symbol]
                hold_data.hold_earn += self.long_profit[vt_symbol]# 这里时是累加，因为总盈亏中还需要包括今天卖出的收益， 即：持仓盈亏 = 已实现盈亏 + 持有的盈亏
                # 多头的今日盈亏有三部分：已兑现的盈亏 + 持仓部分今日盈亏 + 今日开仓的浮盈亏
                # 已兑现的盈亏，卖出时，从成交价减去昨天的收盘价才能算成今日的盈亏
            else:
                self.long_profit[vt_symbol] = 0

            # 新：多头的今日盈亏 = 今天的hold_earn - 昨天的hold_earn
            hold_data: HoldData | None = today_long_hold.get(vt_symbol)
            if hold_data:
                pre_hold_data: HoldData | None = None
                if pre_day:
                    pre_long_hold: dict[str, HoldData] = self.daily_long_hold.get(pre_day, {})
                    pre_hold_data = pre_long_hold.get(vt_symbol)
                if pre_hold_data:
                    hold_data.day_earn = hold_data.hold_earn - pre_hold_data.hold_earn # 今天的持仓盈亏 = 今天的持仓盈亏 - 昨天的持仓盈亏
                else:
                    hold_data.day_earn = hold_data.hold_earn
                today_long_hold[vt_symbol] = hold_data

        for vt_symbol, pos in self.short_pos.items():
            if pos > 0:
                last_price = bars[vt_symbol]["close"]
                contract: ContractData = self.engine.get_contract(vt_symbol)
                self.short_profit[vt_symbol] = (
                    (self.short_avg_cost[vt_symbol] - last_price) * self.short_pos[vt_symbol] * contract.size
                )
            else:
                self.short_profit[vt_symbol] = 0

        hold_earn = sum(self.long_profit.values()) + sum(self.short_profit.values())

        # 更新总资产，包含已实现和未实现盈亏
        self.total = self.capital + self.realized_pnl + hold_earn

        today_account: AccountData = self.daily_account.setdefault(day, AccountData(update=day))
        today_account.update = day
        today_account.total = self.total
        today_account.usable = self.usable
        today_account.frozen = self.frozen
        today_account.hold_earn = hold_earn
        today_account.realized_pnl = self.realized_pnl
        today_account.day_earn = (
            sum(hold.day_earn for hold in today_long_hold.values())
            + sum(hold.day_earn for hold in today_shorthold.values())
        )
        today_account.long_hold = today_long_hold
        today_account.short_hold = today_shorthold

    def get_daily_result(self) -> list[dict]:
        """导出逐日结果（用于绩效统计/分析）。"""
        if not self.daily_account:
            return []

        data_list: list[dict] = []
        for trade_date, account in sorted(self.daily_account.items(), key=lambda item: item[0]):
            data_list.append(
                {
                    "date": trade_date,
                    "net_pnl": account.day_earn,
                    "commission": account.commission,
                    "slippage": account.slippage,
                    "turnover": account.turnover,
                    "trade_count": account.trade_count,
                    # ==== 用来调试检查==========
                    "total": account.total,
                    "usable": account.usable,
                    "frozen": account.frozen,
                    "hold_earn": account.hold_earn,
                    "realized_pnl": account.realized_pnl,
                }
            )
        return data_list
