from __future__ import annotations

import asyncio
from datetime import date, datetime
from typing import Any
from uuid import uuid4

import pytest

from alpha.backtest.analysis import Analysis
from alpha.backtest.data import (
    BacktestDataScope,
    BacktestInput,
    build_contracts,
    build_history_data,
    build_security_profiles,
    build_security_states_by_date,
    load_backtest_input,
)
from alpha.backtest.backtesting import BackTesting
from alpha.backtest.runner import (
    BacktestJobSpec,
    build_common_task_metadata,
    run_backtest_with_input,
    run_optimization_with_input,
    wrap_get_target_value,
)
from alpha.backtest.optimize import OptimizationSetting
from alpha.backtest.template import StrategyTemplate
from alpha.common.schema import Interval, Offset, Product
from alpha.common.schema_trade import ContractData
from alpha.runtime.processes import ProcessTaskManager, TaskStatus
from alpha.strategy.models import (
    SecurityDailyStateData,
    SecurityProfileData,
    SecuritySnapshotData,
)


class MemoryBacktestDatabase:
    """为回测数据装载测试提供最小异步数据库。"""

    def __init__(
        self,
        bars: list[dict[str, Any]],
        profile_rows: list[dict[str, object]] | None = None,
        daily_info_rows: list[dict[str, object]] | None = None,
    ) -> None:
        self._bars = bars
        self._profile_rows = profile_rows or []
        self._daily_info_rows = daily_info_rows or []

    async def load_bars_data(self, queries: list[Any]) -> list[dict[str, Any]]:
        """按查询条件返回内存中的K线数据。"""
        result: list[dict[str, Any]] = []
        for query in queries:
            for bar in self._bars:
                current = datetime.fromisoformat(bar["datetime"])
                if bar["vt_symbol"] != query.vt_symbol:
                    continue
                if bar["interval"] != query.interval or bar["adjust"] != query.adjust:
                    continue
                if query.start <= current <= query.end:
                    result.append(bar)
        return sorted(result, key=lambda item: item["datetime"])

    async def load_security_profiles(self, query: Any) -> list[dict[str, object]]:
        """返回测试证券静态资料。"""
        requested = set(query.vt_symbols or [])
        return [
            row
            for row in self._profile_rows
            if str(row.get("vt_symbol")) in requested
        ]

    async def load_security_daily_info(self, query: Any) -> list[dict[str, object]]:
        """返回测试逐日证券状态。"""
        requested = set(query.vt_symbols)
        start = _normalize_trade_date(query.start)
        end = _normalize_trade_date(query.end)
        return [
            row
            for row in self._daily_info_rows
            if str(row.get("vt_symbol")) in requested
            and start <= str(row.get("trade_date")) <= end
        ]


class CloseOnlyStrategy(StrategyTemplate):
    """用于验证平仓拒单边界的最小策略。"""

    parameters: list[str] = []
    variables: list[str] = []

    def on_bars(self, bars: dict[str, dict]) -> None:
        """首个可交易bar尝试直接卖出平仓。"""
        if not self.active_orderids:
            self.sell("000001.SZSE", bars["000001.SZSE"]["close"], 100)


class AboveUpperLimitBuyStrategy(StrategyTemplate):
    """用于验证超涨停价买单拒绝的最小策略。"""

    parameters: list[str] = []
    variables: list[str] = []

    def on_bars(self, bars: dict[str, dict]) -> None:
        """首个交易日提交超涨停价买单。"""
        if not self.active_orderids:
            self.buy("000001.SZSE", 12.0, 100)


class CountingInitStrategy(StrategyTemplate):
    """用于验证初始化阶段与正式回放边界的最小策略。"""

    parameters: list[str] = []
    variables: list[str] = ["bar_count"]

    def on_init(self) -> None:
        """申请覆盖全部样本的初始化窗口。"""
        self.bar_count = 0
        self.init_bars(10, Interval.DAILY)

    def on_bars(self, bars: dict[str, dict]) -> None:
        """累计收到的bar次数。"""
        self.bar_count += 1


class SimpleTradeStrategy(StrategyTemplate):
    """用于验证回测引擎基础成交链路的最小策略。"""

    parameters: list[str] = []
    variables: list[str] = ["bar_count"]

    def on_init(self) -> None:
        """初始化计数。"""
        self.bar_count = 0

    def on_bars(self, bars: dict[str, dict]) -> None:
        """在固定bar序列上开平仓。"""
        self.bar_count += 1
        vt_symbol = "000001.SZSE"
        bar = bars[vt_symbol]

        if self.bar_count == 1 and self.long_pos[vt_symbol] == 0:
            self.buy(vt_symbol, bar["close"], 100)
        elif self.bar_count == 3 and self.long_pos[vt_symbol] > 0:
            self.sell(vt_symbol, bar["close"], self.long_pos[vt_symbol])


class SecurityContextStrategy(StrategyTemplate):
    """用于验证策略层证券上下文查询接口的最小策略。"""

    parameters: list[str] = []
    variables: list[str] = []

    def on_init(self) -> None:
        """初始化查询结果槽位。"""
        self.profile: SecurityProfileData | None = None
        self.state: SecurityDailyStateData | None = None
        self.snapshot: SecuritySnapshotData | None = None
        self.price_limits: tuple[float | None, float | None] | None = None
        self.in_universe_flag: bool | None = None
        self.is_st_flag: bool = False
        self.is_suspended_flag: bool = False

    def on_bars(self, bars: dict[str, dict]) -> None:
        """在首个交易日读取证券上下文。"""
        if self.profile is not None:
            return

        vt_symbol = "000001.SZSE"
        self.profile = self.get_security_profile(vt_symbol)
        self.state = self.get_security_state(vt_symbol)
        self.snapshot = self.get_security_snapshot(vt_symbol)
        self.price_limits = self.get_price_limits(vt_symbol)
        self.in_universe_flag = self.in_universe(vt_symbol)
        self.is_st_flag = self.is_st(vt_symbol)
        self.is_suspended_flag = self.is_suspended(vt_symbol)


def _make_trending_bars() -> list[dict[str, Any]]:
    """构造可触发双均线开平仓的日线数据。"""
    closes = [
        10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
        10, 10, 10, 10, 10, 11, 12, 13, 14, 15,
        16, 17, 16, 15, 14, 13, 12, 11, 10, 9,
    ]
    bars: list[dict[str, Any]] = []
    for index, close in enumerate(closes, start=1):
        dt = datetime(2024, 1, index)
        bars.append(
            {
                "datetime": dt.isoformat(sep=" "),
                "vt_symbol": "000001.SZSE",
                "symbol": "000001",
                "exchange": "SZSE",
                "interval": "d",
                "adjust": "pre",
                "open": float(close),
                "high": float(close + 0.5),
                "low": float(close - 0.5),
                "close": float(close),
                "volume": 1000.0,
                "turnover": 0.0,
                "open_interest": 0.0,
            }
        )
    return bars


def _make_profile_rows() -> list[dict[str, object]]:
    """构造测试证券静态资料。"""
    return [
        {
            "vt_symbol": "000001.SZSE",
            "asset_type": "stock",
            "board": 10100101,
            "sec_name": "平安银行",
            "sec_abbr": "PAYH",
            "price_tick": 0.02,
            "trade_n": 1,
            "listed_date": "1991-04-03",
            "delisted_date": None,
        }
    ]


def _make_daily_info_rows() -> list[dict[str, object]]:
    """构造测试逐日证券状态。"""
    return [
        {
            "vt_symbol": "000001.SZSE",
            "trade_date": "2024-01-01",
            "is_suspended": False,
            "is_st": False,
        },
        {
            "vt_symbol": "000001.SZSE",
            "trade_date": "2024-01-02",
            "is_suspended": True,
            "is_st": True,
        },
    ]


def _make_bars_with_limits() -> list[dict[str, Any]]:
    """构造带涨跌停价的测试日线。"""
    return [
        {
            "datetime": "2024-01-01 00:00:00",
            "vt_symbol": "000001.SZSE",
            "symbol": "000001",
            "exchange": "SZSE",
            "interval": "d",
            "adjust": "pre",
            "open": 10.0,
            "high": 10.5,
            "low": 9.8,
            "close": 10.2,
            "upper_limit": 11.0,
            "lower_limit": 9.0,
            "volume": 1000.0,
            "turnover": 0.0,
            "open_interest": 0.0,
        },
        {
            "datetime": "2024-01-02 00:00:00",
            "vt_symbol": "000001.SZSE",
            "symbol": "000001",
            "exchange": "SZSE",
            "interval": "d",
            "adjust": "pre",
            "open": 10.2,
            "high": 10.3,
            "low": 10.0,
            "close": 10.1,
            "upper_limit": 11.2,
            "lower_limit": 9.2,
            "volume": 900.0,
            "turnover": 0.0,
            "open_interest": 0.0,
        },
    ]


def _normalize_trade_date(value: object) -> str:
    """将测试入参标准化为交易日字符串。"""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)[:10]


def _make_contract(vt_symbol: str = "000001.SZSE") -> ContractData:
    """构造测试回测合约。"""
    return ContractData(
        gateway_name="backtest",
        vt_symbol=vt_symbol,
        name="平安银行",
        product=Product.ASHARE,
        size=100,
        pricetick=0.01,
        rate=1.1 / 10_000,
        slippage=0.01,
        min_commission=1,
    )


def _make_backtest_input(bars: list[dict[str, Any]]) -> BacktestInput:
    """构造测试回测输入。"""
    return BacktestInput(
        contracts={"000001.SZSE": _make_contract()},
        history_data=build_history_data(bars),
    )


def _make_backtest_input_with_security_context() -> BacktestInput:
    """构造包含完整证券上下文的回测输入。"""
    history_data = build_history_data(_make_bars_with_limits())
    return BacktestInput(
        contracts={"000001.SZSE": _make_contract()},
        history_data=history_data,
        security_profiles=build_security_profiles(_make_profile_rows()),
        security_states_by_date=build_security_states_by_date(
            history_data,
            _make_daily_info_rows(),
        ),
        universe_by_date={
            date(2024, 1, 1): {"000001.SZSE"},
            date(2024, 1, 2): {"000001.SZSE"},
        },
    )


def _make_spec(start: datetime, end: datetime) -> BacktestJobSpec:
    """构造测试回测任务配置。"""
    scope = BacktestDataScope(
        vt_symbols=["000001.SZSE"],
        product=Product.ASHARE,
        interval=Interval.DAILY,
        start=start,
        end=end,
        price_adjust="pre",
    )
    return BacktestJobSpec(
        instance_name="unit_test",
        strategy_class=SimpleTradeStrategy,
        data_scope=scope,
        capital=1_000_000,
    )


@pytest.fixture()
def backtest_engine() -> BackTesting:
    """创建完成一次回测的引擎实例。"""
    engine = BackTesting()
    engine.set_parameters(
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 30),
        capital=1_000_000,
    )
    engine.load_input(_make_backtest_input(_make_trending_bars()))
    engine.add_strategy(SimpleTradeStrategy, "simple_trade_unit_test")
    engine.run_backtesting({})
    return engine


@pytest.fixture()
def security_context_engine() -> BackTesting:
    """创建带证券上下文的回测引擎实例。"""
    engine = BackTesting()
    engine.set_parameters(
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 2),
        capital=1_000_000,
    )
    engine.load_input(_make_backtest_input_with_security_context())
    engine.add_strategy(SecurityContextStrategy, "security_context_unit_test")
    engine.run_backtesting({})
    return engine


def test_backtesting_should_run_without_import_side_effects(backtest_engine: BackTesting) -> None:
    """验证测试文件本身为纯pytest用例且回测可正常执行。"""
    assert backtest_engine.strategy.inited is True
    assert backtest_engine.strategy.trading is False
    assert backtest_engine.datetime == datetime(2024, 1, 30)


def test_backtesting_should_generate_daily_results_and_trades(backtest_engine: BackTesting) -> None:
    """验证最小回测样本可产生日级结果与成交记录。"""
    daily_results = backtest_engine.get_daily_result()
    trades = backtest_engine.get_all_trades()

    assert daily_results
    assert trades
    assert len(backtest_engine.portfolio.daily_account) == 30
    assert any(trade.offset == Offset.OPEN for trade in trades)
    assert any(trade.offset == Offset.CLOSE for trade in trades)


def test_analysis_should_work_with_backtesting_daily_results(backtest_engine: BackTesting) -> None:
    """验证回测结果可以直接进入分析流程。"""
    analysis = Analysis(backtest_engine.get_daily_result(), capital=backtest_engine.capital)

    daily_df = analysis.calculate_dalily(returns=True)
    statistics = analysis.calculate_statistics()

    assert len(daily_df) == 30
    assert statistics["total_days"] == 30
    assert "total_return" in statistics


def test_close_order_without_position_should_be_rejected_without_trade() -> None:
    """验证无持仓平仓时应拒单且不能生成伪成交。"""
    bars = _make_trending_bars()[:3]
    engine = BackTesting()
    engine.set_parameters(
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 3),
        capital=1_000_000,
    )
    engine.load_input(_make_backtest_input(bars))
    engine.add_strategy(CloseOnlyStrategy, "close_only_unit_test")
    engine.run_backtesting({})

    orders = engine.get_all_orders()

    assert len(orders) == 1
    assert orders[0].status.name == "REJECTED"
    assert engine.get_all_trades() == []


def test_order_should_be_rejected_when_price_exceeds_upper_limit() -> None:
    """验证超出涨停价的买单会被拒绝。"""
    engine = BackTesting()
    engine.set_parameters(
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 2),
        capital=1_000_000,
    )
    engine.load_input(_make_backtest_input_with_security_context())
    engine.add_strategy(AboveUpperLimitBuyStrategy, "above_upper_limit_buy_unit_test")
    engine.run_backtesting({})

    orders = engine.get_all_orders()

    assert len(orders) == 1
    assert orders[0].status.name == "REJECTED"
    assert engine.get_all_trades() == []


def test_run_backtesting_should_not_replay_last_bar_when_init_consumes_all_data() -> None:
    """验证初始化阶段覆盖全量数据时不会重复回放最后一根bar。"""
    bars = _make_trending_bars()[:3]
    engine = BackTesting()
    engine.set_parameters(
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 3),
        capital=1_000_000,
    )
    engine.load_input(_make_backtest_input(bars))
    engine.add_strategy(CountingInitStrategy, "counting_init_unit_test")
    engine.run_backtesting({})

    assert engine.strategy.bar_count == 3


def test_wrap_get_target_value_should_read_statistics_field() -> None:
    """验证优化目标值从 statistics 字段中提取。"""
    getter = wrap_get_target_value("total_return")

    value = getter({"statistics": {"total_return": 12.5}})

    assert value == pytest.approx(12.5)


def test_load_backtest_input_should_build_engine_input() -> None:
    """验证数据装载边界可组装完整回测输入。"""
    scope = BacktestDataScope(
        vt_symbols=["000001.SZSE"],
        product=Product.ASHARE,
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 2),
        price_adjust="pre",
    )

    backtest_input = asyncio.run(
        load_backtest_input(
            MemoryBacktestDatabase(
                _make_bars_with_limits(),
                profile_rows=_make_profile_rows(),
                daily_info_rows=_make_daily_info_rows(),
            ),
            scope,
        )
    )

    assert "000001.SZSE" in backtest_input.contracts
    assert datetime(2024, 1, 1) in backtest_input.history_data
    assert backtest_input.history_data[datetime(2024, 1, 1)]["000001.SZSE"]["close"] == pytest.approx(10.2)
    assert backtest_input.contracts["000001.SZSE"].pricetick == pytest.approx(0.02)
    assert backtest_input.security_profiles["000001.SZSE"].pricetick == pytest.approx(0.02)
    assert backtest_input.security_profiles["000001.SZSE"].listed_date == date(1991, 4, 3)
    assert backtest_input.security_states_by_date[date(2024, 1, 1)]["000001.SZSE"].upper_limit == pytest.approx(11.0)
    assert backtest_input.security_states_by_date[date(2024, 1, 2)]["000001.SZSE"].is_st is True
    assert backtest_input.security_states_by_date[date(2024, 1, 2)]["000001.SZSE"].is_suspended is True
    assert backtest_input.universe_by_date[date(2024, 1, 1)] == {"000001.SZSE"}


def test_build_security_profiles_should_map_pricetick_and_dates() -> None:
    """验证证券静态资料会被映射为显式模型。"""
    profiles = build_security_profiles(_make_profile_rows())

    profile: SecurityProfileData = profiles["000001.SZSE"]

    assert profile.vt_symbol == "000001.SZSE"
    assert profile.asset_type == "stock"
    assert profile.sec_name == "平安银行"
    assert profile.sec_abbr == "PAYH"
    assert profile.board == 10100101
    assert profile.pricetick == pytest.approx(0.02)
    assert profile.trade_n == 1
    assert profile.listed_date == date(1991, 4, 3)
    assert profile.delisted_date is None


def test_build_security_states_by_date_should_merge_daily_info_and_limits() -> None:
    """验证逐日证券状态会合并日状态与涨跌停价。"""
    history_data = build_history_data(_make_bars_with_limits())
    states_by_date = build_security_states_by_date(history_data, _make_daily_info_rows())

    first_day_state: SecurityDailyStateData = states_by_date[date(2024, 1, 1)]["000001.SZSE"]
    second_day_state: SecurityDailyStateData = states_by_date[date(2024, 1, 2)]["000001.SZSE"]

    assert first_day_state.trade_date == date(2024, 1, 1)
    assert first_day_state.is_st is False
    assert first_day_state.is_suspended is False
    assert first_day_state.upper_limit == pytest.approx(11.0)
    assert first_day_state.lower_limit == pytest.approx(9.0)
    assert second_day_state.is_st is True
    assert second_day_state.is_suspended is True
    assert second_day_state.upper_limit == pytest.approx(11.2)
    assert second_day_state.lower_limit == pytest.approx(9.2)


def test_backtesting_should_expose_security_context_queries(
    security_context_engine: BackTesting,
) -> None:
    """验证回测引擎会暴露证券资料、逐日状态和快照查询。"""
    profile = security_context_engine.get_security_profile("000001.SZSE")
    state = security_context_engine.get_security_state("000001.SZSE", date(2024, 1, 1))
    snapshot = security_context_engine.get_security_snapshot("000001.SZSE", date(2024, 1, 1))

    assert profile is not None
    assert profile.sec_name == "平安银行"
    assert profile.pricetick == pytest.approx(0.02)
    assert state is not None
    assert state.trade_date == date(2024, 1, 1)
    assert state.is_st is False
    assert state.upper_limit == pytest.approx(11.0)
    assert snapshot is not None
    assert snapshot.profile == profile
    assert snapshot.daily_state == state
    assert snapshot.in_universe is True
    assert security_context_engine.is_st("000001.SZSE", date(2024, 1, 1)) is False
    assert security_context_engine.is_suspended("000001.SZSE", date(2024, 1, 1)) is False
    assert security_context_engine.get_price_limits("000001.SZSE", date(2024, 1, 2)) == pytest.approx((11.2, 9.2))
    assert security_context_engine.in_universe("000001.SZSE", date(2024, 1, 1)) is True


def test_strategy_template_should_proxy_security_context_queries(
    security_context_engine: BackTesting,
) -> None:
    """验证策略模板可直接代理证券上下文查询。"""
    strategy = security_context_engine.strategy

    assert isinstance(strategy, SecurityContextStrategy)
    assert strategy.profile is not None
    assert strategy.profile.sec_name == "平安银行"
    assert strategy.state is not None
    assert strategy.state.trade_date == date(2024, 1, 1)
    assert strategy.snapshot is not None
    assert strategy.snapshot.in_universe is True
    assert strategy.price_limits == pytest.approx((11.0, 9.0))
    assert strategy.in_universe_flag is True
    assert strategy.is_st_flag is False
    assert strategy.is_suspended_flag is False


def test_backtesting_should_reject_future_security_state_queries(
    security_context_engine: BackTesting,
) -> None:
    """验证回测运行态不允许查询未来交易日证券状态。"""
    with pytest.raises(ValueError, match="未来"):
        security_context_engine.get_security_state("000001.SZSE", date(2024, 1, 3))


def test_runner_should_execute_backtest_from_loaded_input() -> None:
    """验证 runner 可使用已加载回测输入同步执行一次回测。"""
    start = datetime(2024, 1, 1)
    end = datetime(2024, 1, 30)
    spec = _make_spec(start, end)
    backtest_input = _make_backtest_input(_make_trending_bars())

    result = run_backtest_with_input(spec, backtest_input, {})

    assert result["param_settings"] == {}
    assert result["trades"]
    assert "total_return" in result["statistics"]


def test_runner_process_should_register_process_task_manager() -> None:
    """验证 runner 子进程回测会登记进程任务状态。"""
    task_id = f"runner-process-{uuid4().hex}"
    task_manager = ProcessTaskManager()
    spec = _make_spec(datetime(2024, 1, 1), datetime(2024, 1, 30))
    backtest_input = _make_backtest_input(_make_trending_bars())

    task_manager.start(
        task_id,
        "backtest",
        run_backtest_with_input,
        args=(spec, backtest_input, {}),
        metadata={
            **build_common_task_metadata(spec),
            "strategy_name": spec.strategy_class.__name__,
        },
        with_publisher=False,
    )
    result = task_manager.wait_result(task_id)
    task = task_manager.get(task_id)

    assert isinstance(result, dict)
    assert result["trades"]
    assert task is not None
    assert task.status == TaskStatus.SUCCEEDED
    assert task.task_type == "backtest"
    assert task.metadata["strategy_name"] == "SimpleTradeStrategy"
    task_manager.close()


def test_runner_optimization_process_should_register_process_task_manager() -> None:
    """验证 runner 子进程优化会登记外层优化任务状态。"""
    optimization_setting = OptimizationSetting()
    optimization_setting.add_parameter("unused", 1)
    optimization_setting.set_target("total_return")

    task_id = f"runner-optimization-{uuid4().hex}"
    task_manager = ProcessTaskManager()
    spec = _make_spec(datetime(2024, 1, 1), datetime(2024, 1, 30))
    backtest_input = _make_backtest_input(_make_trending_bars())

    task_manager.start(
        task_id,
        "optimization",
        run_optimization_with_input,
        args=(
            spec,
            backtest_input,
            optimization_setting,
            "bf",
            1,
        ),
        metadata={
            **build_common_task_metadata(spec),
            "settings_count": len(optimization_setting.generate_settings()),
        },
        with_publisher=False,
    )
    results = task_manager.wait_result(task_id)
    task = task_manager.get(task_id)

    assert isinstance(results, list)
    assert len(results) == 1
    assert task is not None
    assert task.status == TaskStatus.SUCCEEDED
    assert task.task_type == "optimization"
    assert task.metadata["settings_count"] == 1
    task_manager.close()


def test_build_contracts_should_create_default_setting_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """验证缺少合约配置时数据边界能够落默认值。"""
    saved: dict[str, float] = {}

    monkeypatch.setattr("alpha.backtest.data.get_contract_setting", lambda _product: {})
    monkeypatch.setattr(
        "alpha.backtest.data.save_contract_setting",
        lambda _product, settings: saved.update(settings),
    )

    scope = BacktestDataScope(
        vt_symbols=["000001.SZSE"],
        product=Product.ASHARE,
        interval=Interval.DAILY,
        start=datetime(2024, 1, 1),
        end=datetime(2024, 1, 30),
    )
    contracts = build_contracts(
        scope,
        build_security_profiles([{"vt_symbol": "000001.SZSE", "sec_name": "平安银行"}]),
    )

    contract = contracts["000001.SZSE"]

    assert saved["pricetick"] == pytest.approx(0.01)
    assert saved["size"] == 100
    assert contract.pricetick == pytest.approx(0.01)
    assert contract.size == 100
