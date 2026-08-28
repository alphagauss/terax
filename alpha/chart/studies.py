"""公共金融图表的技术指标定义、校验与批量计算。"""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Literal, Mapping, Sequence

StudyType = Literal["sma", "ema", "boll", "rsi", "macd"]
StudyPane = Literal["main", "separate"]
StudySeriesKind = Literal["line", "histogram"]


class StudyValidationError(ValueError):
    """指标实例或参数不符合服务端 definition。"""


class StudyComputationError(RuntimeError):
    """指标依赖失败或返回了无法安全对齐的结果。"""


@dataclass(frozen=True)
class StudyParamDefinition:
    """一个有界数值参数的权威定义。"""

    key: str
    default_value: int | float
    minimum: int | float
    maximum: int | float
    step: int | float


@dataclass(frozen=True)
class StudyOutputDefinition:
    """一个稳定输出序列的渲染无关定义。"""

    id: str
    kind: StudySeriesKind


@dataclass(frozen=True)
class StudyDefinition:
    """服务端权威指标 definition。"""

    type: StudyType
    pane: StudyPane
    params: tuple[StudyParamDefinition, ...]
    outputs: tuple[StudyOutputDefinition, ...]
    levels: tuple[float, ...] = ()


@dataclass(frozen=True)
class NormalizedStudyInstance:
    """已经按 definition 补默认值并校验的计算实例。"""

    instance_id: str
    type: StudyType
    params: dict[str, int | float]


STUDY_DEFINITIONS: tuple[StudyDefinition, ...] = (
    StudyDefinition(
        type="sma",
        pane="main",
        params=(StudyParamDefinition("period", 20, 1, 500, 1),),
        outputs=(StudyOutputDefinition("line", "line"),),
    ),
    StudyDefinition(
        type="ema",
        pane="main",
        params=(StudyParamDefinition("period", 12, 1, 500, 1),),
        outputs=(StudyOutputDefinition("line", "line"),),
    ),
    StudyDefinition(
        type="boll",
        pane="main",
        params=(
            StudyParamDefinition("period", 20, 2, 200, 1),
            StudyParamDefinition("mult", 2, 0.5, 5, 0.5),
        ),
        outputs=(
            StudyOutputDefinition("mid", "line"),
            StudyOutputDefinition("upper", "line"),
            StudyOutputDefinition("lower", "line"),
        ),
    ),
    StudyDefinition(
        type="rsi",
        pane="separate",
        params=(StudyParamDefinition("period", 14, 2, 100, 1),),
        outputs=(StudyOutputDefinition("line", "line"),),
        levels=(30, 70),
    ),
    StudyDefinition(
        type="macd",
        pane="separate",
        params=(
            StudyParamDefinition("fast", 12, 1, 100, 1),
            StudyParamDefinition("slow", 26, 2, 200, 1),
            StudyParamDefinition("signal", 9, 1, 100, 1),
        ),
        outputs=(
            StudyOutputDefinition("macd", "line"),
            StudyOutputDefinition("signal", "line"),
            StudyOutputDefinition("hist", "histogram"),
        ),
        levels=(0,),
    ),
)

_DEFINITION_BY_TYPE: dict[str, StudyDefinition] = {
    definition.type: definition for definition in STUDY_DEFINITIONS
}
_INSTANCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")


def study_definition_payloads() -> list[dict[str, object]]:
    """返回不含用户文案和主题样式的公开 definition 目录。"""
    return [
        {
            "type": definition.type,
            "pane": definition.pane,
            "params": [
                {
                    "key": param.key,
                    "default_value": param.default_value,
                    "min": param.minimum,
                    "max": param.maximum,
                    "step": param.step,
                }
                for param in definition.params
            ],
            "outputs": [
                {"id": output.id, "kind": output.kind} for output in definition.outputs
            ],
            "levels": list(definition.levels),
        }
        for definition in STUDY_DEFINITIONS
    ]


def _normalize_param(
    value: object,
    definition: StudyParamDefinition,
) -> int | float:
    """校验一个数值参数，并保留整数参数的稳定形状。"""
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise StudyValidationError(f"参数 {definition.key} 必须是数字")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise StudyValidationError(f"参数 {definition.key} 必须是有限数字")
    if numeric < definition.minimum or numeric > definition.maximum:
        raise StudyValidationError(f"参数 {definition.key} 超出允许范围")

    steps = (numeric - float(definition.minimum)) / float(definition.step)
    if not math.isclose(steps, round(steps), abs_tol=1e-9):
        raise StudyValidationError(f"参数 {definition.key} 不符合步进")
    if definition.step == 1:
        return int(round(numeric))
    return numeric


def normalize_study_instances(
    instances: Sequence[Mapping[str, object]],
) -> list[NormalizedStudyInstance]:
    """按 definition 校验批量实例，并补齐缺失的默认参数。"""
    if not 1 <= len(instances) <= 8:
        raise StudyValidationError("单次必须计算 1 到 8 个指标实例")

    normalized: list[NormalizedStudyInstance] = []
    seen_ids: set[str] = set()
    for raw in instances:
        instance_id = str(raw.get("instance_id", "")).strip()
        if _INSTANCE_ID_PATTERN.fullmatch(instance_id) is None:
            raise StudyValidationError("指标 instance_id 格式非法")
        if instance_id in seen_ids:
            raise StudyValidationError(f"指标 instance_id 重复: {instance_id}")
        seen_ids.add(instance_id)

        study_type = str(raw.get("type", "")).strip().lower()
        definition = _DEFINITION_BY_TYPE.get(study_type)
        if definition is None:
            raise StudyValidationError(f"不支持的指标类型: {study_type}")

        raw_params = raw.get("params", {})
        if not isinstance(raw_params, Mapping):
            raise StudyValidationError("指标 params 必须是对象")
        declared_keys = {param.key for param in definition.params}
        unknown_keys = set(raw_params) - declared_keys
        if unknown_keys:
            raise StudyValidationError(
                f"指标 {study_type} 包含未知参数: {sorted(unknown_keys)[0]}"
            )

        params = {
            param.key: _normalize_param(
                raw_params.get(param.key, param.default_value),
                param,
            )
            for param in definition.params
        }
        if study_type == "macd" and params["fast"] >= params["slow"]:
            raise StudyValidationError("MACD fast 必须小于 slow")
        normalized.append(
            NormalizedStudyInstance(
                instance_id=instance_id,
                type=definition.type,
                params=params,
            )
        )
    return normalized


def maximum_study_lookback(
    instances: Sequence[NormalizedStudyInstance],
) -> int:
    """返回批量计算所需的最大额外历史 bar 数。"""
    lookbacks: list[int] = []
    for instance in instances:
        if instance.type == "macd":
            lookbacks.append(
                int(instance.params["slow"]) + int(instance.params["signal"])
            )
        else:
            lookbacks.append(int(instance.params["period"]))
    return max(lookbacks, default=0)


def _indicator_class() -> type:
    """按需加载 TA-Lib 包装，未启用指标时不增加 API 启动成本。"""
    from alpha.analytics.indicator import Indicators

    return Indicators


def _calculate_outputs(
    closes: object,
    instance: NormalizedStudyInstance,
) -> dict[str, object]:
    """调用现有 Indicators 计算一个实例的全部稳定输出。"""
    indicators = _indicator_class()
    params = instance.params
    if instance.type == "sma":
        return {"line": indicators.sma(closes, int(params["period"]), True)}
    if instance.type == "ema":
        return {"line": indicators.ema(closes, int(params["period"]), True)}
    if instance.type == "boll":
        upper, mid, lower = indicators.boll_full(
            closes,
            int(params["period"]),
            float(params["mult"]),
            True,
        )
        return {"mid": mid, "upper": upper, "lower": lower}
    if instance.type == "rsi":
        return {"line": indicators.rsi(closes, int(params["period"]), True)}
    macd, signal, hist = indicators.macd(
        closes,
        int(params["fast"]),
        int(params["slow"]),
        int(params["signal"]),
        True,
    )
    return {"macd": macd, "signal": signal, "hist": hist}


def calculate_studies(
    rows: Sequence[Mapping[str, object]],
    instances: Sequence[NormalizedStudyInstance],
    *,
    visible_from: int,
) -> list[dict[str, object]]:
    """批量计算指标，并把非有限值归一为与可见 bars 对齐的空点。"""
    if not 0 <= visible_from <= len(rows):
        raise StudyComputationError("指标可见区间超出行情边界")

    times = [str(row.get("time", "")) for row in rows]
    if any(not value for value in times) or any(
        current <= previous for previous, current in zip(times, times[1:])
    ):
        raise StudyComputationError("指标行情时间必须严格升序")
    try:
        import numpy as np

        closes = np.asarray([float(row["close"]) for row in rows], dtype=float)
    except (KeyError, TypeError, ValueError) as exc:
        raise StudyComputationError("指标行情缺少有效收盘价") from exc
    if not np.isfinite(closes).all():
        raise StudyComputationError("指标行情收盘价包含非有限值")

    results: list[dict[str, object]] = []
    for instance in instances:
        definition = _DEFINITION_BY_TYPE[instance.type]
        if not rows:
            output_arrays = {output.id: [] for output in definition.outputs}
        else:
            try:
                output_arrays = _calculate_outputs(closes, instance)
            except StudyComputationError:
                raise
            except Exception as exc:
                raise StudyComputationError(f"指标 {instance.type} 计算失败") from exc

        outputs: list[dict[str, object]] = []
        for output in definition.outputs:
            values = output_arrays.get(output.id)
            array = np.asarray(values, dtype=float)
            if array.ndim != 1 or len(array) != len(rows):
                raise StudyComputationError(
                    f"指标 {instance.type} 输出 {output.id} 长度错位"
                )
            points = [
                {
                    "time": times[index],
                    "value": (
                        float(array[index])
                        if math.isfinite(float(array[index]))
                        else None
                    ),
                }
                for index in range(visible_from, len(rows))
            ]
            outputs.append({"id": output.id, "kind": output.kind, "points": points})
        results.append(
            {
                "instance_id": instance.instance_id,
                "pane": definition.pane,
                "outputs": outputs,
                "levels": list(definition.levels),
            }
        )
    return results
