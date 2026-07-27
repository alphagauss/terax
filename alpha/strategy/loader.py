import glob
import importlib
import traceback
from pathlib import Path
from types import ModuleType
from typing import Type

from alpha.backtest.template import StrategyTemplate


class StrategyLoader:
    """负责从策略目录扫描并加载策略类。"""

    def __init__(self) -> None:
        """初始化策略加载器。"""
        self.classes: dict[str, Type[StrategyTemplate]] = {}
        self.class_info: dict[str, dict] = {}

    def load_from_default_folder(self) -> bool:
        """从默认策略目录加载策略类。"""
        self.classes.clear()
        self.class_info.clear()

        strategy_path = Path.cwd().joinpath("strategies")
        strategy_path.mkdir(parents=True, exist_ok=True)
        self.load_from_folder(strategy_path, "strategies")
        return True

    def load_from_folder(self, path: Path, module_name: str = "") -> None:
        """从指定目录扫描策略模块。

        Args:
            path: 策略文件目录
            module_name: 模块名前缀
        """
        for suffix in ["py", "pyd", "so"]:
            pathname = str(path.joinpath(f"*.{suffix}"))
            for filepath in glob.glob(pathname):
                stem = Path(filepath).stem
                strategy_module_name = f"{module_name}.{stem}"
                self._load_from_module(strategy_module_name, filepath)

    def _load_from_module(self, module_name: str, filepath: str) -> None:
        """从单个模块中提取策略类。

        Args:
            module_name: Python 模块名
            filepath: 模块文件路径
        """
        try:
            module: ModuleType = importlib.import_module(module_name)
            self._register_strategy_classes(module, filepath)
        except Exception:
            self.class_info[f"load_error::{module_name}"] = {
                "class_name": module_name,
                "desc": "策略模块加载失败",
                "paramaters": {},
                "filepath": filepath,
                "error": traceback.format_exc(),
            }

    def _register_strategy_classes(self, module: ModuleType, filepath: str) -> None:
        """注册模块中的策略类。

        Args:
            module: 已导入模块
            filepath: 模块文件路径
        """
        for name in dir(module):
            value = getattr(module, name)
            if (
                isinstance(value, type)
                and issubclass(value, StrategyTemplate)
                and value is not StrategyTemplate
            ):
                self.classes[value.class_name] = value
                self.class_info[value.class_name] = {
                    "class_name": value.__name__,
                    "desc": value.desc,
                    "paramaters": value.get_class_parameters(),
                    "filepath": filepath,
                }
