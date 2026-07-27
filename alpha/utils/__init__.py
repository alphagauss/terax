import inspect
from contextlib import contextmanager
from contextvars import ContextVar
from decimal import Decimal
from functools import wraps
from math import ceil, floor
import time
from typing import Callable, TypeVar, Optional, Iterator
import os
from pathlib import Path
from loguru import logger

from alpha.common.schema import Product
from alpha.common.paths import  load_json, save_json, get_runtime_subdir

class SingletonMeta(type):
    _instances = {}
    def __call__(cls, *args, **kwargs):
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


def virtual(func: Callable) -> Callable:
    """
    mark a function as "virtual", which means that this function can be override.
    any base class should use this or @abstractmethod to decorate all functions
    that can be (re)implemented by subclasses.
    """
    return func

def round_to(value: float, target: float) -> float:
    """
    Round price to price tick value.
    """
    _value: Decimal = Decimal(str(value))
    _target: Decimal = Decimal(str(target))
    rounded: float = float(int(round(_value / _target)) * target)
    return rounded

def floor_to(value: float, target: float) -> float:
    """
    Similar to math.floor function, but to target float number.
    """
    _value: Decimal = Decimal(str(value))
    _target: Decimal = Decimal(str(target))
    result: float = float(int(floor(_value / _target)) * target)
    return result


def ceil_to(value: float, target: float) -> float:
    """
    Similar to math.ceil function, but to target float number.
    """
    _value: Decimal = Decimal(str(value))
    _target: Decimal = Decimal(str(target))
    result: float = float(int(ceil(_value / _target)) * target)
    return result


def get_digits(value: float) -> int:
    """
    Get number of digits after decimal point.
    """
    value_str: str = str(value)

    if "e-" in value_str:
        _, buf = value_str.split("e-")
        return int(buf)
    elif "." in value_str:
        _, buf = value_str.split(".")
        return len(buf)
    else:
        return 0


F = TypeVar("F", bound=Callable[..., object])
_EXECUTION_TIME_LOGGING_ENABLED: ContextVar[bool] = ContextVar(
    "execution_time_logging_enabled",
    default=True,
)


@contextmanager
def suppress_execution_time_logging() -> Iterator[None]:
    """临时关闭 ``log_execution_time`` 装饰器输出。

    Returns:
        Iterator[None]: 用于 ``with`` 语句的上下文管理器。
    """
    token = _EXECUTION_TIME_LOGGING_ENABLED.set(False)
    try:
        yield
    finally:
        _EXECUTION_TIME_LOGGING_ENABLED.reset(token)

def log_execution_time(tag: Optional[str] = None, width: int = 10) -> Callable[[F], F]:

    def decorator(func: F) -> F:
        raw_label = tag or func.__name__
        label = raw_label.center(max(width, len(raw_label)))

        if inspect.iscoroutinefunction(func):
            # ---------- 异步函数 ----------
            @wraps(func)
            async def async_wrapper(*args, **kwargs):
                start = time.perf_counter()
                try:
                    return await func(*args, **kwargs)        # type: ignore[arg-type]
                finally:
                    elapsed = time.perf_counter() - start
                    if _EXECUTION_TIME_LOGGING_ENABLED.get():
                        logger.opt(depth=1).info("⏱️ {} 耗时 {:.3f} 秒", label, elapsed)

            return async_wrapper  # type: ignore[return-value]

        else:
            # ---------- 同步函数 ----------
            @wraps(func)
            def sync_wrapper(*args, **kwargs):
                # if "单次调用工具" in raw_label:
                #     tool_name = args[0]["tool_name"]
                #     label = f"{label}({tool_name})"
                start = time.perf_counter()
                try:
                    return func(*args, **kwargs)
                finally:
                    elapsed = time.perf_counter() - start
                    if _EXECUTION_TIME_LOGGING_ENABLED.get():
                        logger.opt(depth=1).info("⏱️ {} 耗时 {:.3f} 秒", label, elapsed)

            return sync_wrapper  # type: ignore[return-value]

    return decorator

def get_contract_setting(product: Product) -> dict:
    contract_setting = load_json("contract_setting.json")
    return contract_setting.get(product.value, {})

def save_contract_setting(product: Product, settings: dict):
    contract_setting = load_json("contract_setting.json")
    contract_setting[product.value] = settings
    save_json("contract_setting.json", contract_setting)

strategy_result_folder = "strategy_results"

class StrategyResult:

    @staticmethod
    def get_strategy_result_info() -> dict:
        """获取回测结果信息"""
        result = load_json("info.json", strategy_result_folder)
        return result

    @staticmethod
    def get_strategy_result(key: str) -> dict:
        """获取回测结果"""
        result = load_json(key, strategy_result_folder)
        return result
    
    @staticmethod
    def save_strategy_result(key: str, result: dict) -> None:
        """保存回测结果"""
        save_json(key, result, strategy_result_folder)
        info = load_json("info.json", strategy_result_folder)
        info[key] = result["backtest_req"]
        save_json("info.json", info, strategy_result_folder)

    @staticmethod
    def delete_strategy_result(key: str) -> None:
        """删除回测结果"""
        paraent_path: Path = get_runtime_subdir(strategy_result_folder)
        filepath: Path = paraent_path.joinpath(key)
        if filepath.exists():
            filepath.unlink()
        else:
            return False
        result = load_json("info.json", strategy_result_folder)
        if key in result:
            del result[key]
        save_json("info.json", result, strategy_result_folder)
        return True




