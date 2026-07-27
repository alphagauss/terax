from numpy import ndarray
from loguru import logger

from alpha.common.schema import *
from alpha.backtest.array import ArrayManager
from alpha.backtest.template import StrategyTemplate
from alpha.backtest.indicator import Indicators


class DoubleMaStrategy(StrategyTemplate):
    """(单合约）Double SMA (simple moving average) strategy"""

    class_name: str = "单和约双均线测试1"
    desc: str = "测试文档1"

    fast_window: int = 5
    slow_window: int = 20
    trading_size: int = 100

    fast_ma0 = 0.0
    fast_ma1 = 0.0

    slow_ma0 = 0.0
    slow_ma1 = 0.0

    parameters: list = [
        "fast_window",
        "slow_window",
        "trading_size",
    ]

    variables = ["fast_ma0", "fast_ma1", "slow_ma0", "slow_ma1"]

    def on_init(self) -> None:
        """Callback when strategy is inited"""
        self.array_managers = {}
        self.idxs = {}

        # self.init_bars(10, Interval.MINUTE)

        self.write_log("Strategy is inited.")

    def on_start(self) -> None:
        """Callback when strategy is started"""
        self.write_log("Strategy is started.")

    def on_stop(self) -> None:
        """Callback when strategy is stoped"""
        self.write_log("Strategy is stopped.")

    def on_tick(self, tick: TickData) -> None:
        """Callback of tick data update"""
        self.write_log("on_tick 为空！")

    def on_bars(self, bars: dict[str, dict]) -> None:
        """Callback of candle bar update"""
        self.cancel_all()

        for vt_symbol, bar in bars.items():
            array_manager: ArrayManager = self.array_managers.setdefault(
                vt_symbol, ArrayManager()
            )
            array_manager.update_bar(bar)
            if array_manager.count < self.slow_window + 1:
                continue
            # fast_ma: ndarray = self.idxs.setdefault(
            #     (vt_symbol, "fast_ma"),
            #     Indicators.sma(array_manager.close, self.fast_window),
            # )
            # slow_ma: ndarray = self.idxs.setdefault(
            #     (vt_symbol, "slow_ma"),
            #     Indicators.sma(array_manager.close, self.slow_window),
            # )

            fast_ma: ndarray = Indicators.sma(array_manager.close, self.fast_window)
            slow_ma: ndarray = Indicators.sma(array_manager.close, self.slow_window)

            self.fast_ma0: float = fast_ma[-1].item()
            self.slow_ma0: float = slow_ma[-1].item()
            self.fast_ma1: float = fast_ma[-2].item()
            self.slow_ma1: float = slow_ma[-2].item()

            # 金叉和死差的分析
            cross_over = self.fast_ma0 > self.slow_ma0 and self.fast_ma1 < self.slow_ma1
            cross_below = (
                self.fast_ma0 < self.slow_ma0 and self.fast_ma1 > self.slow_ma1
            )

            long_pos = self.long_pos[vt_symbol]
            if cross_over:
                # 金叉
                if long_pos == 0:
                    self.buy_ratio(vt_symbol, 1.0, bar["close"])
            elif cross_below:
                # 死叉
                if long_pos > 0:
                    self.sell(vt_symbol, bar["close"], long_pos)

        self.put_event()

    def on_trade(self, trade: TradeData) -> None:
        """Callback of trade update"""
        pass

    def on_order(self, order: OrderData) -> None:
        """Callback of order update"""
        pass
