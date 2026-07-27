"""东方财富请求层测试。"""

import asyncio

import httpx

from alpha.market import eastmoney_crawler


def _make_json_response(url: str, data: dict) -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(
        200,
        headers={"content-type": "application/json"},
        json=data,
        request=request,
    )


def _make_html_response(url: str, text: str) -> httpx.Response:
    request = httpx.Request("GET", url)
    return httpx.Response(
        200,
        headers={"content-type": "text/html; charset=utf-8"},
        text=text,
        request=request,
    )


def test_fetch_json_uses_base_request_headers(monkeypatch) -> None:
    """测试请求仅使用固定基础请求头，不携带浏览器 Cookie。"""
    seen_headers: list[dict[str, str]] = []

    async def fake_sleep(seconds: float) -> None:
        del seconds

    async def fake_send_request(
        client: httpx.AsyncClient,
        url: str,
        params: dict,
        headers: dict[str, str],
    ) -> httpx.Response:
        del client, params
        seen_headers.append(headers)
        return _make_json_response(url, {"data": {"answer": 1}})

    monkeypatch.setattr(eastmoney_crawler, "_send_request", fake_send_request)
    monkeypatch.setattr(eastmoney_crawler.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(eastmoney_crawler.random, "uniform", lambda a, b: a)

    async def scenario() -> dict:
        async with httpx.AsyncClient(trust_env=False) as client:
            return await eastmoney_crawler._fetch_json(
                "https://push2.eastmoney.com/api/test",
                {"pn": "1"},
                client=client,
            )

    result = asyncio.run(scenario())

    assert result == {"data": {"answer": 1}}
    assert seen_headers[0]["User-Agent"] == eastmoney_crawler.BASE_REQUEST_HEADERS["User-Agent"]
    assert "Cookie" not in seen_headers[0]


def test_fetch_json_returns_empty_after_antibot(monkeypatch) -> None:
    """测试疑似风控时直接返回空结果，不尝试浏览器会话恢复。"""
    request_count = 0

    async def fake_sleep(seconds: float) -> None:
        del seconds

    async def fake_send_request(
        client: httpx.AsyncClient,
        url: str,
        params: dict,
        headers: dict[str, str],
    ) -> httpx.Response:
        nonlocal request_count
        del client, params, headers
        request_count += 1
        return _make_html_response(url, "安全验证")

    monkeypatch.setattr(eastmoney_crawler, "_send_request", fake_send_request)
    monkeypatch.setattr(eastmoney_crawler.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(eastmoney_crawler.random, "uniform", lambda a, b: a)

    async def scenario() -> dict:
        async with httpx.AsyncClient(trust_env=False) as client:
            return await eastmoney_crawler._fetch_json(
                "https://push2.eastmoney.com/api/test",
                {"pn": "1"},
                client=client,
            )

    result = asyncio.run(scenario())

    assert result == {}
    assert request_count == 1
