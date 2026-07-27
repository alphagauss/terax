# coding=utf-8
"""东方财富掘金量化 GM API 最小封装。

本模块基于 ``gm.api`` 提供常用免费接口的薄封装，目标是：

1. 尽量保持与原始接口一致的函数名、参数名与返回风格；
2. 为项目补充中文文档与基础类型标注；
3. 减少脚本式示例与导入副作用，方便在项目中直接复用。

说明：
    - 文档中的字段清单非常长，本模块在 docstring 中保留核心说明，
      不逐项复制全部字段枚举。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import os
from collections.abc import Callable
from typing import TypeVar

import pandas as pd
from dotenv import load_dotenv

try:
    import gm.api as gm_api
except ImportError as exc:  # pragma: no cover - 依赖由运行环境提供
    raise ImportError("未安装 gm.api，请先在 quant 环境中安装并配置掘金终端。") from exc


SymbolArg = str | list[str]
DateTimeArg = str | dt.datetime
DataFrameOrRecords = pd.DataFrame | list[dict]
T = TypeVar("T")


load_dotenv(override=True)

_TOKEN_ENV_NAME = "EASTMONEY_GM_TOKEN"
_token = os.getenv(_TOKEN_ENV_NAME)
if _token:
    gm_api.set_token(_token)
else:
    raise ValueError(f"未找到掘金 token，请设置环境变量 {_TOKEN_ENV_NAME}。")

ADJUST_NONE = gm_api.ADJUST_NONE
ADJUST_PREV = gm_api.ADJUST_PREV
ADJUST_POST = gm_api.ADJUST_POST


class GMTimeoutError(TimeoutError):
    """GM 接口调用超时异常。"""


async def _run_gm_call(
    func: Callable[..., T],
    /,
    *args: object,
    timeout: float | None = None,
    **kwargs: object,
) -> T:
    """在线程中执行同步 GM 调用，并按需施加超时控制。

    Args:
        func: 要调用的同步 GM 函数。
        *args: 位置参数。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。
        **kwargs: 关键字参数。

    Returns:
        GM 接口返回结果。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。
    """
    task = asyncio.to_thread(func, *args, **kwargs)
    try:
        if timeout is None:
            return await task
        return await asyncio.wait_for(task, timeout=timeout)
    except asyncio.TimeoutError as exc:
        func_name = getattr(func, "__name__", "unknown")
        raise GMTimeoutError(f"GM 接口调用超时: {func_name}, timeout={timeout}s") from exc


#===============================行情数据接口=====================================
async def current(
    symbols: SymbolArg,
    fields: str = "",
    timeout: float | None = None,
) -> list[dict]:
    """查询当前行情快照。

    返回 tick 快照数据。实时模式下返回全部字段；回测模式下通常只返回
    ``symbol``、``price`` 和 ``created_at``。

    Args:
        symbols: 查询代码，支持单个代码、逗号分隔字符串或代码列表。
        fields: 查询字段，默认空字符串表示返回全部字段。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        当前行情快照列表，类型为 ``list[dict]``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 若输入包含无效标的代码，仅返回有效标的对应结果。
        - 若字段中包含错误字段，接口仍返回对应数量的字典，但无效字段值为空字符串或 0。
        - 集合竞价尚未成交时，快照有效字段可能只有盘口 ``quotes``。
    """
    return await _run_gm_call(
        gm_api.current,
        symbols=symbols,
        fields=fields,
        timeout=timeout,
    )


async def history(
    symbol: str,
    frequency: str,
    start_time: DateTimeArg,
    end_time: DateTimeArg,
    fields: str | None = None,
    skip_suspended: bool = True,
    fill_missing: str | None = None,
    adjust: int = ADJUST_NONE,
    adjust_end_time: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询历史行情。

    Args:
        symbol: 标的代码。支持多个标的时需使用英文逗号分隔的字符串，
            不支持 ``list`` 作为入参。
        frequency: 频率，如 ``tick``、``1d``、``60s``。
        start_time: 开始时间，支持字符串或 ``datetime``。
        end_time: 结束时间，支持字符串或 ``datetime``。
        fields: 指定返回字段，多个字段使用英文逗号分隔，默认返回全部字段。
        skip_suspended: 是否跳过停牌。当前接口暂不支持该参数。
        fill_missing: 缺失值填充方式。当前接口暂不支持该参数。
        adjust: 复权方式，默认不复权。
        adjust_end_time: 复权基点时间，默认当前时间。
        df: 是否返回 ``DataFrame``。为 ``False`` 时返回 ``list[dict]``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        历史 tick 或 bar 数据，返回 ``DataFrame`` 或 ``list[dict]``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 返回结果按 ``eob`` 或 ``bob`` 升序排序。
        - 若输入无效标的代码，返回空列表或空 ``DataFrame``。
        - 若字段中包含无效字段，结果只保留 ``eob``、``symbol`` 和有效字段。
        - 单次最多返回 33000 条，超出部分不会返回。
    """
    return await _run_gm_call(
        gm_api.history,
        symbol=symbol,
        frequency=frequency,
        start_time=start_time,
        end_time=end_time,
        fields=fields,
        skip_suspended=skip_suspended,
        fill_missing=fill_missing,
        adjust=adjust,
        adjust_end_time=adjust_end_time,
        df=df,
        timeout=timeout,
    )


#===============================通用数据接口=====================================
async def get_symbol_infos(
    sec_type1: int,
    sec_type2: int | None = None,
    exchanges: SymbolArg | None = None,
    symbols: SymbolArg | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询标的基本信息。

    Args:
        sec_type1: 证券品种大类，一次只能查询一个大类。
        sec_type2: 证券品种细类，默认 ``None`` 表示不区分细类。
        exchanges: 交易所代码，支持逗号分隔字符串或列表。
        symbols: 标的代码，支持逗号分隔字符串或列表。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        标的基本信息列表或 ``DataFrame``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 结果按参数组合求交集。
        - 若参数之间互相矛盾，返回空列表或空 ``DataFrame``。
        - 若 ``symbols`` 中含无效代码，仅返回有效标的数据。
    """
    return await _run_gm_call(
        gm_api.get_symbol_infos,
        sec_type1=sec_type1,
        sec_type2=sec_type2,
        exchanges=exchanges,
        symbols=symbols,
        df=df,
        timeout=timeout,
    )


async def get_symbols(
    sec_type1: int,
    sec_type2: int | None = None,
    exchanges: SymbolArg | None = None,
    symbols: SymbolArg | None = None,
    skip_suspended: bool = True,
    skip_st: bool = True,
    trade_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询指定交易日的多标的交易信息。

    Args:
        sec_type1: 证券品种大类，一次只能查询一个大类。
        sec_type2: 证券品种细类。
        exchanges: 交易所代码，支持字符串或列表。
        symbols: 标的代码，支持字符串或列表。
        skip_suspended: 是否跳过全天停牌。
        skip_st: 是否跳过 ST 股票。
        trade_date: 交易日期，格式为 ``%Y-%m-%d``，默认 ``None`` 表示最新截面。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        指定日期的标的交易信息。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 结果按参数组合求交集。
        - 若输入无效代码，仅返回有效标的数据。
        - ``trade_date`` 为 ``None`` 时，返回最新截面数据。
    """
    return await _run_gm_call(
        gm_api.get_symbols,
        sec_type1=sec_type1,
        sec_type2=sec_type2,
        exchanges=exchanges,
        symbols=symbols,
        skip_suspended=skip_suspended,
        skip_st=skip_st,
        trade_date=trade_date,
        df=df,
        timeout=timeout,
    )


async def get_history_symbol(
    symbol: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询指定标的多日交易信息。

    Args:
        symbol: 标的代码，仅支持单个标的。
        start_date: 开始日期，格式为 ``%Y-%m-%d``。
        end_date: 结束日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        指定标的的历史交易信息。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 返回结果按 ``trade_date`` 升序排序。
        - 若 ``start_date > end_date``，接口会报错。
        - 若输入无效标的代码，返回空列表或空 ``DataFrame``。
    """
    return await _run_gm_call(
        gm_api.get_history_symbol,
        symbol=symbol,
        start_date=start_date,
        end_date=end_date,
        df=df,
        timeout=timeout,
    )


async def get_trading_dates_by_year(
    exchange: str,
    start_year: int,
    end_year: int,
    timeout: float | None = None,
) -> pd.DataFrame:
    """查询年度交易日历。

    Args:
        exchange: 交易所代码，仅支持单个交易所。
        start_year: 开始年份，包含该年份。
        end_year: 结束年份，包含该年份。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        年度交易日历 ``DataFrame``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 若交易所代码错误，接口会报错。
        - 若 ``start_year > end_year``，返回空 ``DataFrame``。
    """
    return await _run_gm_call(
        gm_api.get_trading_dates_by_year,
        exchange=exchange,
        start_year=start_year,
        end_year=end_year,
        timeout=timeout,
    )


async def get_previous_n_trading_dates(
    exchange: str,
    date: str,
    n: int = 1,
    timeout: float | None = None,
) -> list[str]:
    """查询指定日期前 n 个交易日。

    Args:
        exchange: 交易所代码，仅支持单个交易所。
        date: 基准日期，格式为 ``%Y-%m-%d``。
        n: 向前查询的交易日个数，必须为正整数。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        交易日期字符串列表，不包含基准日期当天。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。
    """
    return await _run_gm_call(
        gm_api.get_previous_n_trading_dates,
        exchange=exchange,
        date=date,
        n=n,
        timeout=timeout,
    )


async def get_next_n_trading_dates(
    exchange: str,
    date: str,
    n: int = 1,
    timeout: float | None = None,
) -> list[str]:
    """查询指定日期后 n 个交易日。

    Args:
        exchange: 交易所代码，仅支持单个交易所。
        date: 基准日期，格式为 ``%Y-%m-%d``。
        n: 向后查询的交易日个数，必须为正整数。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        交易日期字符串列表，不包含基准日期当天。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。
    """
    return await _run_gm_call(
        gm_api.get_next_n_trading_dates,
        exchange=exchange,
        date=date,
        n=n,
        timeout=timeout,
    )


async def get_trading_session(
    symbols: SymbolArg,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询交易时段。

    Args:
        symbols: 标的代码，支持逗号分隔字符串或列表。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        标的所属品种的交易时段信息。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 若输入不存在的合约代码，接口会报错提示合约不存在。
    """
    return await _run_gm_call(
        gm_api.get_trading_session,
        symbols=symbols,
        df=df,
        timeout=timeout,
    )


async def get_contract_expire_rest_days(
    symbols: SymbolArg,
    start_date: str | dt.datetime | None = None,
    end_date: str | dt.datetime | None = None,
    trade_flag: bool = False,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询合约到期剩余天数。

    Args:
        symbols: 合约代码，支持字符串或列表。
        start_date: 开始日期，支持可被 ``pd.to_datetime`` 识别的字符串或 ``datetime``。
        end_date: 结束日期，支持可被 ``pd.to_datetime`` 识别的字符串或 ``datetime``。
        trade_flag: 是否按交易日计算，默认按自然日计算。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        到期剩余天数数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 到期日当天返回 0，正数表示未到期，负数表示已过期。
        - 若输入不存在的合约代码，接口会报错。
        - 若某日期合约尚未上市，对应天数返回 ``NaN``。
    """
    return await _run_gm_call(
        gm_api.get_contract_expire_rest_days,
        symbols=symbols,
        start_date=start_date,
        end_date=end_date,
        trade_flag=trade_flag,
        df=df,
        timeout=timeout,
    )



#===============================财务数据和基础数据接口=====================================
async def stk_get_index_constituents(
    index: str,
    trade_date: str | None = None,
    timeout: float | None = None,
) -> pd.DataFrame:
    """查询指数成分股。

    Args:
        index: 指数代码，只支持单个指数。
        trade_date: 交易日期，格式为 ``%Y-%m-%d``，默认 ``None`` 表示最新交易日。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        指数成分股 ``DataFrame``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 数据日频更新，交易日通常约 20 点更新当日数据。
        - 若指定当日但数据尚未更新，可能返回空 ``DataFrame``。
        - 中证系列指数因版权限制，``weight`` 可能为 0。
    """
    return await _run_gm_call(
        gm_api.stk_get_index_constituents,
        index=index,
        trade_date=trade_date,
        timeout=timeout,
    )


async def stk_get_fundamentals_balance(
    symbol: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    fields: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询资产负债表数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        start_date: 开始报告期日期，格式为 ``%Y-%m-%d``。
        end_date: 结束报告期日期，格式为 ``%Y-%m-%d``。
        fields: 返回字段，多个字段使用英文逗号分隔，最多 20 个。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        资产负债表数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近报告期的一条数据。
        - ``start_date > end_date`` 时接口会报错。
        - ``fields`` 填写错误或为空时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_fundamentals_balance,
        symbol=symbol,
        rpt_type=rpt_type,
        data_type=data_type,
        start_date=start_date,
        end_date=end_date,
        fields=fields,
        df=df,
        timeout=timeout,
    )


async def stk_get_fundamentals_cashflow(
    symbol: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    fields: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询现金流量表数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        start_date: 开始报告期日期，格式为 ``%Y-%m-%d``。
        end_date: 结束报告期日期，格式为 ``%Y-%m-%d``。
        fields: 返回字段，多个字段使用英文逗号分隔，最多 20 个。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        现金流量表数据，返回 ``DataFrame`` 或 ``list[dict]``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近报告期的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - 若历史区间内存在多个同类型报表，结果按报告日期顺序返回。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_fundamentals_cashflow,
        symbol=symbol,
        rpt_type=rpt_type,
        data_type=data_type,
        start_date=start_date,
        end_date=end_date,
        fields=fields,
        df=df,
        timeout=timeout,
    )


async def stk_get_fundamentals_income(
    symbol: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    fields: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询利润表数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        start_date: 开始报告期日期，格式为 ``%Y-%m-%d``。
        end_date: 结束报告期日期，格式为 ``%Y-%m-%d``。
        fields: 返回字段，多个字段使用英文逗号分隔，最多 20 个。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        利润表数据，返回 ``DataFrame`` 或 ``list[dict]``。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近报告期的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - 若历史区间内存在多个同类型报表，结果按报告日期顺序返回。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_fundamentals_income,
        symbol=symbol,
        rpt_type=rpt_type,
        data_type=data_type,
        start_date=start_date,
        end_date=end_date,
        fields=fields,
        df=df,
        timeout=timeout,
    )


async def stk_get_fundamentals_balance_pt(
    symbols: SymbolArg,
    rpt_type: int | None = None,
    data_type: int | None = None,
    date: str | None = None,
    fields: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询资产负债表截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        date: 查询日期，类型为发布日期，格式为 ``%Y-%m-%d``。
        fields: 返回字段，多个字段使用英文逗号分隔，最多 20 个。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的资产负债表截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口为 point-in-time 查询，适合做截面研究。
        - 为避免未来数据，指定 ``date`` 后只返回发布日期早于该日期的最新报告数据。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_fundamentals_balance_pt,
        symbols=symbols,
        rpt_type=rpt_type,
        data_type=data_type,
        date=date,
        fields=fields,
        df=df,
        timeout=timeout,
    )


async def stk_get_fundamentals_cashflow_pt(
    symbols: SymbolArg,
    rpt_type: int | None = None,
    data_type: int | None = None,
    date: str | None = None,
    fields: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询现金流量表截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        date: 查询日期，类型为发布日期，格式为 ``%Y-%m-%d``。
        fields: 返回字段，多个字段使用英文逗号分隔，最多 20 个。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的现金流量表截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口为 point-in-time 查询。
        - 指定 ``date`` 后，只返回发布日期早于该日期的最新报告数据。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_fundamentals_cashflow_pt,
        symbols=symbols,
        rpt_type=rpt_type,
        data_type=data_type,
        date=date,
        fields=fields,
        df=df,
        timeout=timeout,
    )


async def stk_get_fundamentals_income_pt(
    symbols: SymbolArg,
    rpt_type: int | None = None,
    data_type: int | None = None,
    date: str | None = None,
    fields: str = "",
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询利润表截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        date: 查询日期，类型为发布日期，格式为 ``%Y-%m-%d``。
        fields: 返回字段，多个字段使用英文逗号分隔，最多 20 个。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的利润表截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口为 point-in-time 查询。
        - 指定 ``date`` 后，只返回发布日期早于该日期的最新报告数据。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_fundamentals_income_pt,
        symbols=symbols,
        rpt_type=rpt_type,
        data_type=data_type,
        date=date,
        fields=fields,
        df=df,
        timeout=timeout,
    )


async def stk_get_finance_prime(
    symbol: str,
    fields: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询财务主要指标数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        start_date: 开始报告期日期，格式为 ``%Y-%m-%d``。
        end_date: 结束报告期日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        财务主要指标数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近报告期的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - 若历史区间内存在多个同类型报表，结果按报告日期顺序返回。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_finance_prime,
        symbol=symbol,
        fields=fields,
        rpt_type=rpt_type,
        data_type=data_type,
        start_date=start_date,
        end_date=end_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_finance_deriv(
    symbol: str,
    fields: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询财务衍生指标数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        start_date: 开始报告期日期，格式为 ``%Y-%m-%d``。
        end_date: 结束报告期日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        财务衍生指标数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近报告期的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - 若历史区间内存在多个同类型报表，结果按报告日期顺序返回。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_finance_deriv,
        symbol=symbol,
        fields=fields,
        rpt_type=rpt_type,
        data_type=data_type,
        start_date=start_date,
        end_date=end_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_daily_valuation(
    symbol: str,
    fields: str,
    start_date: str | None = None,
    end_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询估值指标每日数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        start_date: 开始交易日期，格式为 ``%Y-%m-%d``。
        end_date: 结束交易日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        每日估值指标数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近交易日的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_daily_valuation,
        symbol=symbol,
        fields=fields,
        start_date=start_date,
        end_date=end_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_daily_mktvalue(
    symbol: str,
    fields: str,
    start_date: str | None = None,
    end_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询市值指标每日数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        start_date: 开始交易日期，格式为 ``%Y-%m-%d``。
        end_date: 结束交易日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        每日市值指标数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近交易日的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_daily_mktvalue,
        symbol=symbol,
        fields=fields,
        start_date=start_date,
        end_date=end_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_daily_basic(
    symbol: str,
    fields: str,
    start_date: str | None = None,
    end_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询股本等基础指标每日数据。

    Args:
        symbol: 股票代码，仅支持单个标的。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        start_date: 开始交易日期，格式为 ``%Y-%m-%d``。
        end_date: 结束交易日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        每日基础指标数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - ``start_date == end_date`` 时，返回离 ``end_date`` 最近交易日的一条数据。
        - ``start_date < end_date`` 时，返回指定区间内的数据。
        - ``start_date > end_date`` 时接口会报错。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_daily_basic,
        symbol=symbol,
        fields=fields,
        start_date=start_date,
        end_date=end_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_finance_prime_pt(
    symbols: SymbolArg,
    fields: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询财务主要指标截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        date: 查询日期，类型为发布日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的财务主要指标截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口为 point-in-time 查询。
        - 指定 ``date`` 后，只返回发布日期早于该日期的最新报告数据。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_finance_prime_pt,
        symbols=symbols,
        fields=fields,
        rpt_type=rpt_type,
        data_type=data_type,
        date=date,
        df=df,
        timeout=timeout,
    )


async def stk_get_finance_deriv_pt(
    symbols: SymbolArg,
    fields: str,
    rpt_type: int | None = None,
    data_type: int | None = None,
    date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询财务衍生指标截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        rpt_type: 报表类型，如一季报、中报、三季报、年报。
        data_type: 数据类型，如合并原始、合并调整、母公司原始、母公司调整。
        date: 查询日期，类型为发布日期，格式为 ``%Y-%m-%d``。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的财务衍生指标截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口为 point-in-time 查询。
        - 指定 ``date`` 后，只返回发布日期早于该日期的最新报告数据。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_finance_deriv_pt,
        symbols=symbols,
        fields=fields,
        rpt_type=rpt_type,
        data_type=data_type,
        date=date,
        df=df,
        timeout=timeout,
    )


async def stk_get_daily_valuation_pt(
    symbols: SymbolArg,
    fields: str,
    trade_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询估值指标单日截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        trade_date: 查询交易日期，格式为 ``%Y-%m-%d``，默认 ``None`` 表示最新日期。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的单日估值指标截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口按交易日查询单日截面。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_daily_valuation_pt,
        symbols=symbols,
        fields=fields,
        trade_date=trade_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_daily_mktvalue_pt(
    symbols: SymbolArg,
    fields: str,
    trade_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询市值指标单日截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        trade_date: 查询交易日期，格式为 ``%Y-%m-%d``，默认 ``None`` 表示最新日期。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的单日市值指标截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口按交易日查询单日截面。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_daily_mktvalue_pt,
        symbols=symbols,
        fields=fields,
        trade_date=trade_date,
        df=df,
        timeout=timeout,
    )


async def stk_get_daily_basic_pt(
    symbols: SymbolArg,
    fields: str,
    trade_date: str | None = None,
    df: bool = False,
    timeout: float | None = None,
) -> DataFrameOrRecords:
    """查询股本等基础指标单日截面数据。

    Args:
        symbols: 股票代码，支持逗号分隔字符串或列表。
        fields: 指标字段，多个字段使用英文逗号分隔，最多 20 个。
        trade_date: 查询交易日期，格式为 ``%Y-%m-%d``，默认 ``None`` 表示最新日期。
        df: 是否返回 ``DataFrame``。
        timeout: 超时时间，单位秒。为 ``None`` 时表示不限制超时。

    Returns:
        多标的单日基础指标截面数据。

    Raises:
        GMTimeoutError: 当设置了 ``timeout`` 且调用超时时抛出。

    Notes:
        - 该接口按交易日查询单日截面。
        - ``fields`` 填写错误、为空或超过 20 个字段时会报错。
    """
    return await _run_gm_call(
        gm_api.stk_get_daily_basic_pt,
        symbols=symbols,
        fields=fields,
        trade_date=trade_date,
        df=df,
        timeout=timeout,
    )


__all__ = [
    "ADJUST_NONE",
    "ADJUST_POST",
    "ADJUST_PREV",
    "GMTimeoutError",
    "current",
    "history",
    "get_symbol_infos",
    "get_symbols",
    "get_history_symbol",
    "get_trading_dates_by_year",
    "get_previous_n_trading_dates",
    "get_next_n_trading_dates",
    "get_trading_session",
    "get_contract_expire_rest_days",
    "stk_get_index_constituents",
    "stk_get_fundamentals_balance",
    "stk_get_fundamentals_cashflow",
    "stk_get_fundamentals_income",
    "stk_get_fundamentals_balance_pt",
    "stk_get_fundamentals_cashflow_pt",
    "stk_get_fundamentals_income_pt",
    "stk_get_finance_prime",
    "stk_get_finance_deriv",
    "stk_get_daily_valuation",
    "stk_get_daily_mktvalue",
    "stk_get_daily_basic",
    "stk_get_finance_prime_pt",
    "stk_get_finance_deriv_pt",
    "stk_get_daily_valuation_pt",
    "stk_get_daily_mktvalue_pt",
    "stk_get_daily_basic_pt",
]
