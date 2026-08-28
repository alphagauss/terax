"""测试图表指标 definition、参数边界和批量结果对齐。"""

from __future__ import annotations

import numpy as np
import pytest

from alpha.chart import studies


class FakeIndicators:
    """返回确定性数组的现有指标包装替身。"""

    @staticmethod
    def sma(close: np.ndarray, n: int, array: bool = True) -> np.ndarray:
        assert array is True
        return close + n

    @staticmethod
    def ema(close: np.ndarray, n: int, array: bool = True) -> np.ndarray:
        assert array is True
        return close + n * 2

    @staticmethod
    def boll_full(
        close: np.ndarray,
        n: int,
        dev: float,
        array: bool = True,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        assert array is True
        return close + n + dev, close + n, close - n - dev

    @staticmethod
    def rsi(close: np.ndarray, n: int, array: bool = True) -> np.ndarray:
        assert array is True
        return np.array([np.nan, 50.0, np.inf])[: len(close)]

    @staticmethod
    def macd(
        close: np.ndarray,
        fast_period: int,
        slow_period: int,
        signal_period: int,
        array: bool = True,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        assert array is True
        return close + fast_period, close + slow_period, close + signal_period


def test_study_definitions_have_stable_defaults_and_outputs() -> None:
    """首批目录只暴露五类稳定 definition，不携带文案和主题。"""
    payloads = studies.study_definition_payloads()

    assert [item["type"] for item in payloads] == [
        "sma",
        "ema",
        "boll",
        "rsi",
        "macd",
    ]
    assert payloads[2]["params"] == [
        {"key": "period", "default_value": 20, "min": 2, "max": 200, "step": 1},
        {"key": "mult", "default_value": 2, "min": 0.5, "max": 5, "step": 0.5},
    ]
    assert payloads[3]["levels"] == [30, 70]
    assert payloads[4]["outputs"][-1] == {"id": "hist", "kind": "histogram"}


def test_study_params_apply_defaults_and_accept_boundaries() -> None:
    """缺失参数使用默认值，合法边界保持稳定数值类型。"""
    normalized = studies.normalize_study_instances(
        [
            {"instance_id": "sma-1", "type": "sma", "params": {"period": 500}},
            {"instance_id": "boll-1", "type": "boll", "params": {"mult": 0.5}},
        ]
    )

    assert normalized[0].params == {"period": 500}
    assert normalized[1].params == {"period": 20, "mult": 0.5}
    assert studies.maximum_study_lookback(normalized) == 500


@pytest.mark.parametrize(
    ("study_type", "params", "expected"),
    [
        ("sma", {"period": 1}, {"period": 1}),
        ("sma", {"period": 500}, {"period": 500}),
        ("ema", {"period": 1}, {"period": 1}),
        ("ema", {"period": 500}, {"period": 500}),
        ("boll", {"period": 2, "mult": 0.5}, {"period": 2, "mult": 0.5}),
        ("boll", {"period": 200, "mult": 5}, {"period": 200, "mult": 5.0}),
        ("rsi", {"period": 2}, {"period": 2}),
        ("rsi", {"period": 100}, {"period": 100}),
        (
            "macd",
            {"fast": 1, "slow": 200, "signal": 100},
            {"fast": 1, "slow": 200, "signal": 100},
        ),
    ],
)
def test_each_study_accepts_declared_parameter_boundaries(
    study_type: str,
    params: dict[str, int | float],
    expected: dict[str, int | float],
) -> None:
    """首批五类指标的边界值与 definition 保持一致。"""
    normalized = studies.normalize_study_instances(
        [{"instance_id": "study-1", "type": study_type, "params": params}]
    )

    assert normalized[0].params == expected


@pytest.mark.parametrize(
    "instance",
    [
        {"instance_id": "sma-1", "type": "sma", "params": {"period": 0}},
        {"instance_id": "boll-1", "type": "boll", "params": {"mult": 0.6}},
        {"instance_id": "rsi-1", "type": "rsi", "params": {"unknown": 1}},
        {
            "instance_id": "macd-1",
            "type": "macd",
            "params": {"fast": 26, "slow": 26},
        },
    ],
)
def test_study_params_reject_invalid_values(instance: dict[str, object]) -> None:
    """范围、步进、未知参数和 MACD 交叉约束均由服务端拒绝。"""
    with pytest.raises(studies.StudyValidationError):
        studies.normalize_study_instances([instance])


def test_study_instances_reject_duplicate_ids_and_batch_overflow() -> None:
    """批量响应不能产生歧义 instance ID，数量上限固定为八个。"""
    duplicate = {"instance_id": "same", "type": "sma", "params": {}}
    with pytest.raises(studies.StudyValidationError, match="重复"):
        studies.normalize_study_instances([duplicate, duplicate])
    with pytest.raises(studies.StudyValidationError, match="1 到 8"):
        studies.normalize_study_instances([])
    with pytest.raises(studies.StudyValidationError, match="1 到 8"):
        studies.normalize_study_instances(
            [
                {"instance_id": f"sma-{index}", "type": "sma", "params": {}}
                for index in range(9)
            ]
        )


def test_calculate_studies_preserves_identity_and_normalizes_non_finite_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """批量输出保持实例和 output ID，并把不可序列化值转为空点。"""
    monkeypatch.setattr(studies, "_indicator_class", lambda: FakeIndicators)
    instances = studies.normalize_study_instances(
        [
            {"instance_id": "rsi-1", "type": "rsi", "params": {}},
            {"instance_id": "macd-1", "type": "macd", "params": {}},
        ]
    )
    rows = [{"time": f"2026-08-{day:02d}", "close": float(day)} for day in range(1, 4)]

    result = studies.calculate_studies(rows, instances, visible_from=1)

    assert [item["instance_id"] for item in result] == ["rsi-1", "macd-1"]
    assert result[0]["outputs"][0]["points"] == [
        {"time": "2026-08-02", "value": 50.0},
        {"time": "2026-08-03", "value": None},
    ]
    assert [output["id"] for output in result[1]["outputs"]] == [
        "macd",
        "signal",
        "hist",
    ]


def test_calculate_studies_maps_all_first_batch_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """首批五类指标都通过同一公共内核映射为稳定 output ID。"""
    monkeypatch.setattr(studies, "_indicator_class", lambda: FakeIndicators)
    instances = studies.normalize_study_instances(
        [
            {"instance_id": "sma-1", "type": "sma", "params": {}},
            {"instance_id": "ema-1", "type": "ema", "params": {}},
            {"instance_id": "boll-1", "type": "boll", "params": {}},
            {"instance_id": "rsi-1", "type": "rsi", "params": {}},
            {"instance_id": "macd-1", "type": "macd", "params": {}},
        ]
    )
    rows = [{"time": f"2026-08-{day:02d}", "close": float(day)} for day in range(1, 4)]

    result = studies.calculate_studies(rows, instances, visible_from=0)

    assert {
        item["instance_id"]: [output["id"] for output in item["outputs"]]
        for item in result
    } == {
        "sma-1": ["line"],
        "ema-1": ["line"],
        "boll-1": ["mid", "upper", "lower"],
        "rsi-1": ["line"],
        "macd-1": ["macd", "signal", "hist"],
    }


def test_calculate_studies_handles_empty_visible_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """空行情仍返回稳定实例与输出结构，但不调用指标依赖。"""
    monkeypatch.setattr(
        studies,
        "_indicator_class",
        lambda: pytest.fail("空行情不应加载指标依赖"),
    )
    instances = studies.normalize_study_instances(
        [{"instance_id": "sma-1", "type": "sma", "params": {}}]
    )

    result = studies.calculate_studies([], instances, visible_from=0)

    assert result[0]["outputs"][0]["points"] == []


def test_calculate_studies_rejects_misaligned_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """依赖返回长度错位时整次计算失败，不能返回部分结果。"""

    class BrokenIndicators(FakeIndicators):
        """返回错误长度的指标替身。"""

        @staticmethod
        def sma(close: np.ndarray, n: int, array: bool = True) -> np.ndarray:
            return close[:-1]

    monkeypatch.setattr(studies, "_indicator_class", lambda: BrokenIndicators)
    instances = studies.normalize_study_instances(
        [{"instance_id": "sma-1", "type": "sma", "params": {}}]
    )

    with pytest.raises(studies.StudyComputationError, match="长度错位"):
        studies.calculate_studies(
            [
                {"time": "2026-08-01", "close": 1.0},
                {"time": "2026-08-02", "close": 2.0},
            ],
            instances,
            visible_from=0,
        )
