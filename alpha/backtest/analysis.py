"""回测结果的日度指标与统计分析。

本模块只计算并返回可序列化的回测数据，不负责图表渲染，绘图由 Web 端完成。
"""

from datetime import date
from typing import Callable

import numpy as np
from loguru import logger
from pandas import DataFrame, Series
from pandas.core.window import ExponentialMovingWindow


class Analysis:
    def __init__(
        self,
        data: list[dict],
        output: Callable | None = None,
        capital: float = 1000000,  # 初始资金
        annual_days: int = 240,  # 年化交易日数量
        risk_free: float = 0,  # 无风险利率 (年化)
        half_life: int = 120,  # 在组合回测中没有这个
    ) -> None:
        """初始化回测分析器。

        Args:
            data: 逐日回测结果
            output: 输出函数
            capital: 初始资金
            annual_days: 年化交易日数量
            risk_free: 无风险利率
            half_life: 指数加权半衰期

        df 必须有的列
        df["date"]
        df["net_pnl"]  net_pnl:每日的 当日净盈亏
        df["commission"]: 每日的手续费
        df["slippage"]: 每日的滑点
        df["turnover"]: 每日的成交金额
        df["trade_count"]: 每日的成交笔数
        """
        if output is None:
            output = logger.info
        self.output = output
        self.capital = capital
        self.annual_days = annual_days
        self.risk_free = risk_free
        self.half_life = half_life

        if not data:
            self.output("统计分析：data 不能为空")
            self.df = DataFrame()
            return
            # raise ValueError("data 不能为空")
        self.df = DataFrame(data)
        self.df.set_index("date", inplace=True)
        self.df.sort_index(inplace=True)

        for col in ["commission", "slippage", "turnover", "trade_count"]:
            if col not in self.df.columns:
                self.output(f"df 必须包含 {col} 列")
                self.df[col] = 0
        
        self.init_daily: bool = False
    
    def calculate_dalily(self, returns: bool = False) -> list[dict] | DataFrame | None:
        """计算逐日统计字段。

        Args:
            returns: 是否返回计算后的结果

        Returns:
            空数据时返回空列表；需要返回结果时返回 DataFrame；爆仓时返回 None
        """
        if self.df.empty:
            return []
        self.output(self.df.describe())
        self.output("开始计算策略统计指标")        

        self.df["balance"] = self.df["net_pnl"].cumsum() + self.capital  # 这个可以没
        # 当资金小于等于0时，设为0
        self.df["balance"] = self.df["balance"].clip(lower=0)

        pre_balance: Series = self.df["balance"].shift(1)
        pre_balance.iloc[0] = self.capital
        x = self.df["balance"] / pre_balance
        x[x <= 0] = np.nan
        self.df["return"] = np.log(x).fillna(0)
        # df["return"] = np.log(df["balance"] / df["balance"].shift(1)).fillna(0)

        # 计算历史最高水位：滚动窗口计算从开始到当前时点的最大余额值
        self.df["highlevel"] = (
            self.df["balance"].rolling(min_periods=1, window=len(self.df), center=False).max()
        )
        # 计算回撤：当前余额减去历史最高水位得到绝对回撤
        self.df["drawdown"] = self.df["balance"] - self.df["highlevel"]
        # 计算回撤百分比：回撤金额除以历史最高水位再乘以100得到百分比回撤
        self.df["ddpercent"] = self.df["drawdown"] / self.df["highlevel"] * 100

        # Check if margin call is raised
        positive_balance = (self.df["balance"] > 0).all()
        if not positive_balance:
            self.output("回测中出现爆仓（资金小于等于0），无法计算策略统计指标")
            return
        
        self.init_daily = True
        
        if returns:
            return self.df.reset_index()
    
    def calculate_statistics(self) -> dict:
        """计算策略统计指标。

        Returns:
            统计指标字典
        """
        if self.df.empty:
            return {}
        if not self.init_daily:
            self.calculate_dalily()
        
        # 初始化统计指标
        idx = {}
        idx_map = {
            "start_date": "首个交易日",
            "end_date": "最后交易日",
            "total_days": "总交易日",
            "profit_days": "盈利交易日",
            "loss_days": "亏损交易日",
            "end_balance": "结束资金",
            "max_drawdown": "最大回撤",
            "max_ddpercent": "最大回撤百分比",
            "max_drawdown_duration": "最大回撤持续天数",
            "total_net_pnl": "总盈亏",
            "daily_net_pnl": "日均盈亏",
            "total_commission": "总手续费",
            "daily_commission": "日均手续费",
            "total_slippage": "总滑点",
            "daily_slippage": "日均滑点",
            "total_turnover": "总成交金额",
            "daily_turnover": "日均成交金额",
            "total_trade_count": "总成交笔数",
            "daily_trade_count": "日均成交笔数",
            "total_return": "总收益率",
            "annual_return": "年化收益",
            "daily_return": "日均收益率",
            "return_std": "收益标准差",
            "sharpe_ratio": "Sharpe Ratio",
            "ewm_sharpe": "EWM Sharpe",
            "return_drawdown_ratio": "收益回撤比",
        }        
            
        idx["start_date"] = self.df.index[0]
        idx["end_date"] = self.df.index[-1]
        idx["total_days"] = len(self.df)
        idx["profit_days"] = len(self.df[self.df["net_pnl"] > 0])
        idx["loss_days"] = len(self.df[self.df["net_pnl"] < 0])

        idx["end_balance"] = self.df["balance"].iloc[-1]
        idx["max_drawdown"] = self.df["drawdown"].min()
        idx["max_ddpercent"] = self.df["ddpercent"].min()        
        

        max_drawdown_end = self.df["drawdown"].idxmin()
        if isinstance(max_drawdown_end, date):
            max_drawdown_start = self.df["balance"][:max_drawdown_end].idxmax()
            idx["max_drawdown_duration"] = (max_drawdown_end - max_drawdown_start).days
        else:
            idx["max_drawdown_duration"] = 0

        idx["total_net_pnl"] = self.df["net_pnl"].sum()
        idx["daily_net_pnl"] = self.df["net_pnl"].mean()

        idx["total_commission"] = self.df["commission"].sum()
        idx["daily_commission"] = self.df["commission"].mean()

        idx["total_slippage"] = self.df["slippage"].sum()
        idx["daily_slippage"] = self.df["slippage"].mean()

        idx["total_turnover"] = self.df["turnover"].sum()
        idx["daily_turnover"] = self.df["turnover"].mean()

        idx["total_trade_count"] = self.df["trade_count"].sum()
        idx["daily_trade_count"] = self.df["trade_count"].mean()

        idx["total_return"] = (idx["end_balance"] / self.capital - 1) * 100
        idx["annual_return"] = idx["total_return"] / idx["total_days"] * self.annual_days
        idx["daily_return"] = self.df["return"].mean() * 100
        idx["return_std"] = self.df["return"].std() * 100

        if idx["return_std"]:
            daily_risk_free: float = self.risk_free / np.sqrt(self.annual_days)
            idx["sharpe_ratio"] = (
                (idx["daily_return"] - daily_risk_free)
                / idx["return_std"]
                * np.sqrt(self.annual_days)
            )
            ewm_window: ExponentialMovingWindow = self.df["return"].ewm(halflife=self.half_life)
            ewm_mean: Series = ewm_window.mean() * 100
            ewm_std: Series = ewm_window.std() * 100
            idx["ewm_sharpe"] = ((ewm_mean - daily_risk_free) / ewm_std).iloc[-1] * np.sqrt(
                self.annual_days
            )
        else:
            idx["sharpe_ratio"] = 0
            idx["ewm_sharpe"] = 0

        # return_drawdown_ratio: float = -total_net_pnl / max_drawdown
        if idx["max_ddpercent"]:
            idx["return_drawdown_ratio"] = -idx["total_return"] / idx["max_ddpercent"]
        else:
            idx["return_drawdown_ratio"] = 0

        self.output("-" * 30)
        for k, data in idx.items():
            if isinstance(data, np.integer):
                data = int(data)
            elif isinstance(data, np.floating):
                data = round(float(data), 2)
            idx[k] = data
            self.output(f"{idx_map[k]}: {data}")
        self.output("策略统计指标计算完成")

        return idx

