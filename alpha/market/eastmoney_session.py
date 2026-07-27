from __future__ import annotations

import asyncio
from pathlib import Path
from time import time
from typing import Protocol, cast
from urllib.parse import urlparse

from loguru import logger

from alpha.common.paths import get_file_path
from alpha.common.paths import  load_json, save_json

EASTMONEY_HOME_URL = "https://quote.eastmoney.com/"
EASTMONEY_COOKIE_DOMAINS = (
    "quote.eastmoney.com",
    "searchapi.eastmoney.com",
    "push2.eastmoney.com",
    "push2his.eastmoney.com",
)
EASTMONEY_COOKIE_URLS = tuple(f"https://{domain}/" for domain in EASTMONEY_COOKIE_DOMAINS)
DEFAULT_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60


class _PlaywrightPage(Protocol):
    """声明当前模块真正依赖的页面能力，避免直接依赖具体类型。"""

    async def goto(self, url: str, wait_until: str = "load") -> object:
        ...


class EastmoneyCookieManager:
    """管理东方财富请求所需的 Cookie，并在失效时触发浏览器续期。"""

    def __init__(
        self,
        cookie_file: Path | None = None,
        session: EastmoneyPlaywrightSession | None = None,
        cookie_max_age_seconds: float = DEFAULT_COOKIE_MAX_AGE_SECONDS,
    ) -> None:
        self.cookie_file = cookie_file or get_file_path("eastmoney_cookies.json")
        self.session = session or EastmoneyPlaywrightSession()
        self.cookie_max_age_seconds = cookie_max_age_seconds
        self._refresh_lock = asyncio.Lock()
        self._cookies: list[dict[str, str]] = []
        self._updated_at: float = 0.0
        self._blocked_count: int = 0
        self._load_from_disk()

    def _load_from_disk(self) -> None:
        """从磁盘恢复最近一次成功获取的 Cookie。"""
        data = load_json(self.cookie_file.name)
        cookies = data.get("cookies")
        updated_at = data.get("updated_at")
        if isinstance(cookies, list):
            self._cookies = [
                cookie
                for cookie in cookies
                if isinstance(cookie, dict)
                and isinstance(cookie.get("name"), str)
                and isinstance(cookie.get("value"), str)
            ]
        if isinstance(updated_at, (int, float)):
            self._updated_at = float(updated_at)

    def _save_to_disk(self) -> None:
        """将最新 Cookie 持久化到本地，便于进程重启后复用。"""
        save_json(
            self.cookie_file.name,
            {
                "updated_at": self._updated_at,
                "blocked_count": self._blocked_count,
                "cookies": self._cookies,
            },
        )

    def get_cookie_header(self, url: str) -> str:
        """根据目标域名筛选 Cookie，并拼接为请求头。"""
        hostname = (urlparse(url).hostname or "").lower()
        matched: list[str] = []
        for cookie in self._cookies:
            if not self._cookie_matches_url(cookie, hostname, url):
                continue
            name = cookie.get("name", "")
            value = cookie.get("value", "")
            if name:
                matched.append(f"{name}={value}")
        return "; ".join(matched)

    def _cookie_matches_url(self, cookie: dict[str, str], hostname: str, url: str) -> bool:
        """仅发送域名、路径和安全属性都匹配的 Cookie。"""
        domain = cookie.get("domain", "").lstrip(".").lower()
        if not domain:
            return False
        if hostname != domain and not hostname.endswith(f".{domain}"):
            return False

        path = cookie.get("path", "/") or "/"
        request_path = urlparse(url).path or "/"
        if not request_path.startswith(path):
            return False

        is_secure = str(cookie.get("secure", "")).lower() == "true"
        if is_secure and not url.startswith("https://"):
            return False
        return True

    def mark_success(self) -> None:
        """请求成功后清空连续风控计数。"""
        self._blocked_count = 0

    def mark_blocked(self) -> None:
        """记录一次疑似风控命中。"""
        self._blocked_count += 1

    def has_cookies(self) -> bool:
        """判断当前内存中是否已有可用 Cookie。"""
        return bool(self._cookies)

    def cookie_age_seconds(self) -> float | None:
        """返回当前 Cookie 距离上次刷新的秒数。"""
        if not self._updated_at:
            return None
        return max(time() - self._updated_at, 0.0)

    def should_refresh_before_request(self) -> bool:
        """判断当前 Cookie 是否过旧，是否应在正式请求前预热。"""
        if not self.has_cookies():
            return True

        cookie_age = self.cookie_age_seconds()
        if cookie_age is None:
            return True
        return cookie_age >= self.cookie_max_age_seconds

    async def refresh_cookies(self) -> list[dict[str, str]]:
        """通过 Playwright 会话刷新 Cookie，并确保同一时刻只刷新一次。"""
        async with self._refresh_lock:
            cookies = await self.session.refresh_cookies()
            if cookies:
                self._cookies = cookies
                self._updated_at = time()
                self._blocked_count = 0
                self._save_to_disk()
            return list(self._cookies)

    async def warmup(self, force_refresh: bool = False) -> list[dict[str, str]]:
        """在正式抓取前预热浏览器会话，必要时主动获取最新 Cookie。"""
        if not force_refresh and not self.should_refresh_before_request():
            return list(self._cookies)
        return await self.refresh_cookies()


class EastmoneyPlaywrightSession:
    """维护一个常驻的 Playwright 浏览器会话，供人工介入验证码后导出 Cookie。"""

    def __init__(
        self,
        storage_state_file: Path | None = None,
        quote_url: str = EASTMONEY_HOME_URL,
    ) -> None:
        self.storage_state_file = storage_state_file or get_file_path("eastmoney_storage_state.json")
        self.quote_url = quote_url
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._browser_lock = asyncio.Lock()

    async def _ensure_page(self) -> _PlaywrightPage:
        """懒加载有头浏览器，并复用同一个页面。"""
        async with self._browser_lock:
            if self._page is not None:
                return cast(_PlaywrightPage, self._page)

            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=False)

            storage_state: str | None = None
            if self.storage_state_file.exists():
                storage_state = str(self.storage_state_file)

            self._context = await self._browser.new_context(storage_state=storage_state)
            self._page = await self._context.new_page()
            await self._page.goto(self.quote_url, wait_until="domcontentloaded")
            return cast(_PlaywrightPage, self._page)

    async def refresh_cookies(self, timeout_seconds: float = 180.0) -> list[dict[str, str]]:
        """打开东方财富首页并等待人工完成验证，然后导出最新 Cookie。"""
        page = await self._ensure_page()
        context = self._context
        if context is None:
            return []

        logger.warning(
            "东方财富 Cookie 可能已失效，已打开浏览器窗口。"
            "如页面出现验证码，请手动完成验证，程序会自动读取新的 Cookie。"
        )
        await page.goto(self.quote_url, wait_until="domcontentloaded")

        deadline = time() + timeout_seconds
        while time() < deadline:
            cookies = await context.cookies(list(EASTMONEY_COOKIE_URLS))
            normalized = self._normalize_cookies(cookies)
            if self._has_usable_cookies(normalized):
                await context.storage_state(path=str(self.storage_state_file))
                return normalized
            await asyncio.sleep(1.0)

        logger.error("等待东方财富 Cookie 刷新超时，请确认浏览器中已完成验证。")
        return []

    def _normalize_cookies(self, cookies: list[dict[str, object]]) -> list[dict[str, str]]:
        """仅保留请求层真正需要的 Cookie 字段。"""
        normalized: list[dict[str, str]] = []
        for cookie in cookies:
            name = cookie.get("name")
            value = cookie.get("value")
            domain = cookie.get("domain")
            if not isinstance(name, str) or not isinstance(value, str) or not isinstance(domain, str):
                continue

            normalized.append(
                {
                    "name": name,
                    "value": value,
                    "domain": domain,
                    "path": str(cookie.get("path", "/")),
                    "secure": str(cookie.get("secure", False)).lower(),
                }
            )
        return normalized

    def _has_usable_cookies(self, cookies: list[dict[str, str]]) -> bool:
        """只要拿到东财域下的有效 Cookie，就允许请求层先继续工作。"""
        for cookie in cookies:
            domain = cookie.get("domain", "").lower()
            if domain.endswith("eastmoney.com") and cookie.get("name"):
                return True
        return False

    async def close(self) -> None:
        """关闭浏览器资源。"""
        if self._context is not None:
            await self._context.close()
            self._context = None
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None
        self._page = None
