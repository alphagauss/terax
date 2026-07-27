from collections.abc import Iterable
from typing import Dict, List, Callable, Tuple
from itertools import product
from concurrent.futures import ProcessPoolExecutor
from random import random, choice
from time import perf_counter
from multiprocessing import get_context
from multiprocessing.context import BaseContext

from tqdm import tqdm
from deap import creator, base, tools, algorithms


OUTPUT_FUNC = Callable[[str], None]
EVALUATE_FUNC = Callable[[dict], dict]
KEY_FUNC = Callable[[dict], float]


# 创建遗传算法优化所需的个体类型。
if not hasattr(creator, "FitnessMax"):
    creator.create("FitnessMax", base.Fitness, weights=(1.0,))
if not hasattr(creator, "Individual"):
    creator.create("Individual", list, fitness=creator.FitnessMax)


class OptimizationSetting:
    """参数优化配置。"""

    def __init__(self) -> None:
        self.params: Dict[str, List] = {}
        self.target_name: str = ""

    def add_parameter(
        self,
        name: str,
        start: float,
        end: float = None,
        step: float = None
    ) -> Tuple[bool, str]:
        """添加优化参数。

        Args:
            name: 参数名称。
            start: 固定参数值或范围起始值。
            end: 范围终止值；为空时表示固定参数。
            step: 范围步进；为空时表示固定参数。

        Returns:
            是否添加成功，以及对应提示文本。
        """

        if end is None and step is None:
            self.params[name] = [start]
            return True, "固定参数添加成功"

        if start >= end:
            return False, "参数优化起始点必须小于终止点"

        if step <= 0:
            return False, "参数优化步进必须大于0"

        value: float = start
        value_list: List[float] = []

        while value <= end:
            value_list.append(value)
            value += step

        self.params[name] = value_list

        return True, f"范围参数添加成功，数量{len(value_list)}"

    def set_target(self, target_name: str) -> None:
        """设置优化目标字段。

        Args:
            target_name: 回测统计结果中的目标字段名。
        """

        self.target_name = target_name

    def generate_settings(self) -> List[dict]:
        """生成完整参数组合。

        Returns:
            参数组合列表。
        """

        keys = self.params.keys()
        values = self.params.values()
        products: list = list(product(*values))

        settings: list = []
        for p in products:
            setting: dict = dict(zip(keys, p))
            settings.append(setting)

        return settings


def check_optimization_setting(
    optimization_setting: OptimizationSetting,
    output: OUTPUT_FUNC = print
) -> bool:
    """检查优化配置是否完整。

    Args:
        optimization_setting: 参数优化配置。
        output: 日志输出函数。

    Returns:
        配置是否可执行优化。
    """

    if not optimization_setting.generate_settings():
        output("优化参数组合为空，请检查")
        return False

    if not optimization_setting.target_name:
        output("优化目标未设置，请检查")
        return False

    return True


def run_bf_optimization(
    evaluate_func: EVALUATE_FUNC,
    optimization_setting: OptimizationSetting,
    key_func: KEY_FUNC,
    max_workers: int = None,
    output: OUTPUT_FUNC = print
) -> list[dict]:
    """执行穷举参数优化。

    Args:
        evaluate_func: 单组参数回测评估函数。
        optimization_setting: 参数优化配置。
        key_func: 优化目标提取函数。
        max_workers: 最大工作进程数。
        output: 日志输出函数。

    Returns:
        按优化目标降序排列的回测结果列表。
    """

    settings: List[Dict] = optimization_setting.generate_settings()

    output("开始执行穷举算法优化")
    output(f"参数优化空间：{len(settings)}")

    start: int = perf_counter()

    if max_workers == 1:
        it: Iterable = tqdm(
            (evaluate_func(setting) for setting in settings),
            total=len(settings),
        )
        results: list[dict] = list(it)
    else:
        with ProcessPoolExecutor(
            max_workers,
            mp_context=get_context("spawn")
        ) as executor:
            it = tqdm(
                executor.map(evaluate_func, settings),
                total=len(settings)
            )
            results = list(it)

    results.sort(reverse=True, key=key_func)

    end: int = perf_counter()
    cost: int = int((end - start))
    output(f"穷举算法优化完成，耗时{cost}秒")

    return results


def run_ga_optimization(
    evaluate_func: EVALUATE_FUNC,
    optimization_setting: OptimizationSetting,
    key_func: KEY_FUNC,
    max_workers: int = None,
    population_size: int = 100,
    ngen_size: int = 30,
    output: OUTPUT_FUNC = print
) -> list[dict]:
    """执行遗传算法参数优化。

    Args:
        evaluate_func: 单组参数回测评估函数。
        optimization_setting: 参数优化配置。
        key_func: 优化目标提取函数。
        max_workers: 最大工作进程数。
        population_size: 每代族群数量。
        ngen_size: 迭代代数。
        output: 日志输出函数。

    Returns:
        按优化目标降序排列的回测结果列表。
    """

    # 随机生成遗传算法个体参数。
    buf: List[Dict] = optimization_setting.generate_settings()
    settings: List[Tuple] = [list(d.items()) for d in buf]

    def generate_parameter() -> list:
        """"""
        return choice(settings)

    def mutate_individual(individual: list, indpb: float) -> tuple:
        """"""
        size: int = len(individual)
        paramlist: list = generate_parameter()
        for i in range(size):
            if random() < indpb:
                individual[i] = paramlist[i]
        return individual,

    # 初始化进程池与跨进程缓存。
    ctx: BaseContext = get_context("spawn")
    with ctx.Manager() as manager, ctx.Pool(max_workers) as pool:
        cache: Dict[Tuple, Tuple] = manager.dict()

        # 配置 DEAP 工具箱。
        toolbox: base.Toolbox = base.Toolbox()
        toolbox.register("individual", tools.initIterate, creator.Individual, generate_parameter)
        toolbox.register("population", tools.initRepeat, list, toolbox.individual)
        toolbox.register("mate", tools.cxTwoPoint)
        toolbox.register("mutate", mutate_individual, indpb=1)
        toolbox.register("select", tools.selNSGA2)
        toolbox.register("map", pool.map)
        toolbox.register(
            "evaluate",
            ga_evaluate,
            cache,
            evaluate_func,
            key_func
        )

        total_size: int = len(settings)
        pop_size: int = population_size                      # number of individuals in each generation
        lambda_: int = pop_size                              # number of children to produce at each generation
        mu: int = int(pop_size * 0.8)                        # number of individuals to select for the next generation

        cxpb: float = 0.95         # probability that an offspring is produced by crossover
        mutpb: float = 1 - cxpb    # probability that an offspring is produced by mutation
        ngen: int = ngen_size    # number of generation

        pop: list = toolbox.population(pop_size)

        # 运行遗传算法优化。
        output("开始执行遗传算法优化")
        output(f"参数优化空间：{total_size}")
        output(f"每代族群总数：{pop_size}")
        output(f"优良筛选个数：{mu}")
        output(f"迭代次数：{ngen}")
        output(f"交叉概率：{cxpb:.0%}")
        output(f"突变概率：{mutpb:.0%}")

        start: int = perf_counter()

        algorithms.eaMuPlusLambda(
            pop,
            toolbox,
            mu,
            lambda_,
            cxpb,
            mutpb,
            ngen,
            verbose=True
        )

        end: int = perf_counter()
        cost: int = int((end - start))

        output(f"遗传算法优化完成，耗时{cost}秒")

        results: list = list(cache.values())
        results.sort(reverse=True, key=key_func)
        return results


def ga_evaluate(
    cache: dict,
    evaluate_func: EVALUATE_FUNC,
    key_func: KEY_FUNC,
    parameters: list
) -> tuple[float]:
    """执行遗传算法中的单个个体评估。

    Args:
        cache: 进程间共享的评估结果缓存。
        evaluate_func: 单组参数回测评估函数。
        key_func: 优化目标提取函数。
        parameters: 个体参数列表。

    Returns:
        DEAP 需要的单元素适应度元组。
    """

    tp: tuple = tuple(parameters)
    if tp in cache:
        result: tuple = cache[tp]
    else:
        setting: dict = dict(parameters)
        result: dict = evaluate_func(setting)
        cache[tp] = result

    value: float = key_func(result)
    return (value, )
