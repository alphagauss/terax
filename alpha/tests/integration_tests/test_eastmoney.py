"""东方财富行情分页逻辑测试。"""

import asyncio
from typing import Any

import pytest

from alpha.market import eastmoney_crawler


@pytest.fixture(autouse=True)
def disable_environment_proxies(monkeypatch: pytest.MonkeyPatch) -> None:
    """分页测试不继承宿主机代理，避免已替换的网络层仍受环境影响。"""

    for variable in (
        "ALL_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "all_proxy",
        "https_proxy",
        "http_proxy",
    ):
        monkeypatch.delenv(variable, raising=False)


def test_market_realtime_pagination(monkeypatch) -> None:
    """测试 market_realtime 会根据 total 拉取多页并合并。"""
    responses_by_page: dict[str, dict[str, Any]] = {
        "1": {
            "data": {
                "total": 201,
                "diff": [
                    {
                        "f12": "000001",
                        "f14": "平安银行",
                        "f3": "1.2",
                        "f13": "0",
                        "f124": "2026-02-27",
                    },
                    {
                        "f12": "600000",
                        "f14": "浦发银行",
                        "f3": "1.0",
                        "f13": "1",
                        "f124": "2026-02-27",
                    },
                ],
            }
        },
        "2": {
            "data": {
                "total": 201,
                "diff": [
                    {
                        "f12": "000002",
                        "f14": "万科A",
                        "f3": "0.9",
                        "f13": "0",
                        "f124": "2026-02-27",
                    },
                ],
            }
        },
    }
    called_pages: list[str] = []

    async def fake_fetch_json(
        url: str, params: dict[str, Any], timeout: float, client
    ) -> dict[str, Any]:
        del url, timeout, client
        page = str(params.get("pn", "1"))
        called_pages.append(page)
        return responses_by_page.get(page, {"data": {"total": 0, "diff": []}})

    monkeypatch.setattr(eastmoney_crawler, "_fetch_json", fake_fetch_json)

    result = asyncio.run(eastmoney_crawler.market_realtime("沪深A"))

    assert called_pages == ["1", "2", "3"]
    assert len(result) == 3
    assert list(result["代码"]) == ["000001", "600000", "000002"]


def test_market_realtime_empty_first_page(monkeypatch) -> None:
    """测试第一页无数据时返回空结果。"""

    async def fake_fetch_json(
        url: str, params: dict[str, Any], timeout: float, client
    ) -> dict[str, Any]:
        del url, params, timeout, client
        return {"data": {"total": 0, "diff": []}}

    monkeypatch.setattr(eastmoney_crawler, "_fetch_json", fake_fetch_json)

    result = asyncio.run(eastmoney_crawler.market_realtime("沪深A"))

    assert result.empty
    assert "市场" in result.columns


def test_market_realtime_break_on_empty_middle_page(monkeypatch) -> None:
    """测试中间页为空时会提前退出分页请求。"""
    responses_by_page: dict[str, dict[str, Any]] = {
        "1": {
            "data": {
                "total": 600,
                "diff": [
                    {
                        "f12": "000001",
                        "f14": "平安银行",
                        "f3": "1.2",
                        "f13": "0",
                        "f124": "2026-02-27",
                    },
                ],
            }
        },
        "2": {"data": {"total": 600, "diff": []}},
        "3": {
            "data": {
                "total": 600,
                "diff": [
                    {
                        "f12": "000002",
                        "f14": "万科A",
                        "f3": "0.9",
                        "f13": "0",
                        "f124": "2026-02-27",
                    },
                ],
            }
        },
    }
    called_pages: list[str] = []

    async def fake_fetch_json(
        url: str, params: dict[str, Any], timeout: float, client
    ) -> dict[str, Any]:
        del url, timeout, client
        page = str(params.get("pn", "1"))
        called_pages.append(page)
        return responses_by_page.get(page, {"data": {"total": 0, "diff": []}})

    monkeypatch.setattr(eastmoney_crawler, "_fetch_json", fake_fetch_json)

    result = asyncio.run(eastmoney_crawler.market_realtime("沪深A"))

    assert called_pages == ["1", "2"]
    assert len(result) == 1
    assert list(result["代码"]) == ["000001"]
