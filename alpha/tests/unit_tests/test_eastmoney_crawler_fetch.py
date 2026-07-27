"""东方财富请求层测试。"""

import asyncio

import httpx

from alpha.market import eastmoney_crawler


class _FakeCookieManager:
    """用于替换真实 Cookie 管理器的测试桩。"""

    def __init__(self) -> None:
        self.cookie_header = ""
        self.blocked_count = 0
        self.success_count = 0
        self.refresh_count = 0
        self.cookie_age = None
        self.should_refresh = False

    def get_cookie_header(self, url: str) -> str:
        del url
        return self.cookie_header

    def has_cookies(self) -> bool:
        return bool(self.cookie_header)

    def cookie_age_seconds(self) -> float | None:
        return self.cookie_age

    def should_refresh_before_request(self) -> bool:
        return self.should_refresh

    def mark_success(self) -> None:
        self.success_count += 1

    def mark_blocked(self) -> None:
        self.blocked_count += 1

    async def refresh_cookies(self) -> list[dict[str, str]]:
        self.refresh_count += 1
        self.cookie_header = "session=fresh"
        return [{"name": "session", "value": "fresh", "domain": "push2.eastmoney.com", "path": "/"}]

    async def warmup(self, force_refresh: bool = False) -> list[dict[str, str]]:
        if not force_refresh and not self.should_refresh_before_request():
            return [{"name": "session", "value": "cached", "domain": "push2.eastmoney.com", "path": "/"}]
        return await self.refresh_cookies()


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


def test_fetch_json_attaches_cookie_header(monkeypatch) -> None:
    """测试请求会自动携带 Cookie 头。"""
    fake_manager = _FakeCookieManager()
    fake_manager.cookie_header = "session=abc"
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

    monkeypatch.setattr(eastmoney_crawler, "_COOKIE_MANAGER", fake_manager)
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
    assert seen_headers[0]["Cookie"] == "session=abc"
    assert fake_manager.success_count == 1


def test_fetch_json_refreshes_cookie_after_antibot(monkeypatch) -> None:
    """测试疑似风控时会刷新 Cookie 并重试。"""
    fake_manager = _FakeCookieManager()
    responses = [
        _make_html_response("https://push2.eastmoney.com/api/test", "安全验证"),
        _make_json_response("https://push2.eastmoney.com/api/test", {"data": {"ok": True}}),
    ]
    seen_headers: list[dict[str, str]] = []

    async def fake_sleep(seconds: float) -> None:
        del seconds

    async def fake_send_request(
        client: httpx.AsyncClient,
        url: str,
        params: dict,
        headers: dict[str, str],
    ) -> httpx.Response:
        del client, url, params
        seen_headers.append(headers)
        return responses.pop(0)

    monkeypatch.setattr(eastmoney_crawler, "_COOKIE_MANAGER", fake_manager)
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

    assert result == {"data": {"ok": True}}
    assert fake_manager.blocked_count == 1
    assert fake_manager.refresh_count == 1
    assert fake_manager.success_count == 1
    assert "Cookie" not in seen_headers[0]
    assert seen_headers[1]["Cookie"] == "session=fresh"


def test_warmup_session_uses_cached_cookie(monkeypatch) -> None:
    """测试预热入口在已有 Cookie 时不会重复刷新。"""
    fake_manager = _FakeCookieManager()
    fake_manager.cookie_header = "session=cached"
    fake_manager.cookie_age = 60.0
    fake_manager.should_refresh = False

    monkeypatch.setattr(eastmoney_crawler, "_COOKIE_MANAGER", fake_manager)

    result = asyncio.run(eastmoney_crawler.warmup_eastmoney_session())

    assert result is True
    assert fake_manager.refresh_count == 0


def test_warmup_session_force_refresh(monkeypatch) -> None:
    """测试强制预热会主动刷新 Cookie。"""
    fake_manager = _FakeCookieManager()
    fake_manager.cookie_header = "session=old"

    monkeypatch.setattr(eastmoney_crawler, "_COOKIE_MANAGER", fake_manager)

    result = asyncio.run(eastmoney_crawler.warmup_eastmoney_session(force_refresh=True))

    assert result is True
    assert fake_manager.refresh_count == 1


def test_get_eastmoney_session_status(monkeypatch) -> None:
    """测试会话状态接口会暴露 Cookie 年龄和预热建议。"""
    fake_manager = _FakeCookieManager()
    fake_manager.cookie_header = "session=current"
    fake_manager.cookie_age = 3600.0
    fake_manager.should_refresh = False

    monkeypatch.setattr(eastmoney_crawler, "_COOKIE_MANAGER", fake_manager)

    result = eastmoney_crawler.get_eastmoney_session_status()

    assert result == {
        "has_cookies": True,
        "cookie_age_seconds": 3600.0,
        "should_refresh_before_request": False,
    }
