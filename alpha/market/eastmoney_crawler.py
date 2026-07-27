import asyncio
import random
from datetime import datetime
from typing import Any, Dict, Iterable
from urllib.parse import urlparse

import httpx
import pandas as pd
from loguru import logger

from alpha.market.eastmoney_session import EastmoneyCookieManager


# 东方财富网基础请求头，Cookie 会在请求前按目标域名动态附加。
BASE_REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}

_REQUEST_TIMEOUT = 15.0
_REQUEST_SEMAPHORE = asyncio.Semaphore(8)
_COOKIE_MANAGER = EastmoneyCookieManager()

code_id_dict = {
    '上证综指': '1.000001', 'sh': '1.000001', '上证指数': '1.000001', '1.000001': '1.000001',
    '深证综指': '0.399106', 'sz': '0.399106', '深证指数': '0.399106', '深证成指': '0.399106',
    '创业板指': '0.399006', 'cyb': '0.399006', '创业板': '0.399006', '创业板指数': '0.399006',
    '沪深300': '1.000300', 'hs300': '1.000300',
    '上证50': '1.000016', 'sz50': '1.000016',
    '上证180': '1.000010', 'sz180': '1.000010',
    '科创50': '1.000688', 'kc50': '1.000688',
    '中小100': '0.399005', 'zxb': '0.399005', '中小板': '0.399005', '中小板指数': '0.399005', '深圳100': '0.399005',
    '标普500': '100.SPX', 'SPX': '100.SPX', 'spx': '100.SPX', '标普指数': '100.SPX',
    '纳斯达克': '100.NDX', '纳斯达克指数': '100.NDX', 'NSDQ': '100.NDX', 'nsdq': '100.NDX',
    '道琼斯': '100.DJIA', 'DJIA': '100.DJIA', 'dqs': '100.DJIA', '道琼斯指数': '100.DJIA',
}

trade_detail_dict = {
    'f12': '代码',
    'f14': '名称',
    'f3': '涨幅',
    'f2': '最新',
    'f15': '最高',
    'f16': '最低',
    'f17': '今开',
    'f8': '换手率',
    'f10': '量比',
    'f9': '市盈率',
    'f5': '成交量',
    'f6': '成交额',
    'f18': '昨收',
    'f20': '总市值',
    'f21': '流通市值',
    'f13': '编号',
    'f124': '时间',
}

# 市场编号
market_num_dict = {
    '0': '深A',
    '1': '沪A',
    '105': '美股',
    '106': '美股',
    '107': '美股',
    '116': '港股',
    '128': '港股',
    '113': '上期所',
    '114': '大商所',
    '115': '郑商所',
    '8': '中金所',
    '142': '上海能源期货交易所',
    '155': '英股',
    '90': '板块'
}


async def _fetch_json(
    url: str,
    params: Dict[str, Any],
    timeout: float = _REQUEST_TIMEOUT,
    client: httpx.AsyncClient | None = None,
) -> Dict[str, Any]:
    """异步请求 JSON 数据，内置限流、抖动和重试。"""
    max_retries = 3
    base_delay = 1.0
    random_delay_range = (0.1, 0.4)
    refreshed_cookies = False

    async with _REQUEST_SEMAPHORE:
        await asyncio.sleep(random.uniform(0.25, 0.8))
        for attempt in range(max_retries):
            try:
                headers = _build_request_headers(url)
                if client is None:
                    async with httpx.AsyncClient(timeout=timeout) as local_client:
                        response = await _send_request(
                            local_client,
                            url=url,
                            params=params,
                            headers=headers,
                        )
                else:
                    response = await _send_request(
                        client,
                        url=url,
                        params=params,
                        headers=headers,
                    )

                response.raise_for_status()
                data = _decode_json_response(response)
                if _looks_like_antibot_response(url, response, data):
                    raise EastmoneyAntiBotError(f"东方财富接口触发风控：{urlparse(url).netloc}")

                _COOKIE_MANAGER.mark_success()
                return data if isinstance(data, dict) else {}

            except EastmoneyAntiBotError as exc:
                logger.warning(str(exc))
                _COOKIE_MANAGER.mark_blocked()
                if refreshed_cookies:
                    logger.error("刷新 Cookie 后仍命中风控，放弃本次请求。")
                    return {}

                cookies = await _COOKIE_MANAGER.refresh_cookies()
                refreshed_cookies = True
                if not cookies:
                    logger.error("Cookie 刷新失败，无法继续请求东方财富接口。")
                    return {}
                await asyncio.sleep(1.0)

            except (httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
                if attempt == max_retries - 1:
                    # raise RuntimeError(f"请求失败，已达最大重试次数: {exc}") from exc
                    logger.exception(f"请求失败，已达最大重试次数: {exc}")
                    return {}

                logger.warning(f"请求错误，正在重试... (第 {attempt + 1} 次)")
                delay = base_delay * (2 ** attempt) + random.uniform(*random_delay_range)
                await asyncio.sleep(delay)


class EastmoneyAntiBotError(RuntimeError):
    """东方财富触发风控时抛出的异常。"""


async def warmup_eastmoney_session(force_refresh: bool = False) -> bool:
    """预热东方财富浏览器会话，默认仅在 Cookie 缺失或过旧时才刷新。"""
    cookies = await _COOKIE_MANAGER.warmup(force_refresh=force_refresh)
    return bool(cookies)


def get_eastmoney_session_status() -> dict[str, Any]:
    """返回当前东财会话状态，便于脚本在预热前判断。"""
    return {
        "has_cookies": _COOKIE_MANAGER.has_cookies(),
        "cookie_age_seconds": _COOKIE_MANAGER.cookie_age_seconds(),
        "should_refresh_before_request": _COOKIE_MANAGER.should_refresh_before_request(),
    }


def _build_request_headers(url: str) -> dict[str, str]:
    """构造请求头，并按目标域名附带对应的 Cookie。"""
    headers = dict(BASE_REQUEST_HEADERS)
    cookie_header = _COOKIE_MANAGER.get_cookie_header(url)
    if cookie_header:
        headers["Cookie"] = cookie_header
    return headers


async def _send_request(
    client: httpx.AsyncClient,
    url: str,
    params: Dict[str, Any],
    headers: dict[str, str],
) -> httpx.Response:
    """统一封装 GET 请求，便于测试中替换网络层。"""
    return await client.get(url, params=params, headers=headers)


def _decode_json_response(response: httpx.Response) -> Dict[str, Any]:
    """解析 JSON 响应；若格式异常则回退为空字典。"""
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _looks_like_antibot_response(
    url: str,
    response: httpx.Response,
    data: Dict[str, Any],
) -> bool:
    """根据状态码、内容类型和关键字识别东财风控页。"""
    if response.status_code in {403, 429}:
        return True

    content_type = response.headers.get("content-type", "").lower()
    response_text = response.text.lower()
    blocked_keywords = (
        "captcha",
        "validate",
        "verification",
        "访问过于频繁",
        "安全验证",
        "请输入验证码",
        "人机验证",
    )
    if any(keyword in response_text for keyword in blocked_keywords):
        return True

    if "html" in content_type and "eastmoney" in urlparse(url).netloc:
        return True

    if not data:
        return False

    message = str(data.get("message", "")).lower()
    if any(keyword in message for keyword in ("captcha", "validate", "频繁", "验证")):
        return True

    return False


def trans_num(df: pd.DataFrame, ignore_cols: Iterable[str]) -> pd.DataFrame:
    """将 DataFrame 中非忽略列批量转换为数值。"""
    trans_cols = list(set(df.columns) - set(ignore_cols))
    if trans_cols:
        df[trans_cols] = df[trans_cols].apply(lambda s: pd.to_numeric(s, errors='coerce'))
    return df


async def get_code_id(code: str) -> str | None:
    """生成东方财富行情 secid，支持代码、简称和指数别名。"""
    code = str(code).strip()
    if code in code_id_dict:
        return code_id_dict[code]

    if code.isdigit() and len(code) == 6:
        return f"{1 if code.startswith(('5', '6')) else 0}.{code}"

    params = {
        'input': code,
        'type': '14',
        'token': 'D43BF722C8E33BDC906FB84D85E326E8',
    }

    url = 'https://searchapi.eastmoney.com/api/suggest/get'
    response = await _fetch_json(url, params)
    code_list = ((response.get('QuotationCodeTable') or {}).get('Data') or [])
    return code_list[0].get('QuoteID') if code_list else None


async def market_realtime(market: str = '沪深A', timeout: float = 15.0) -> pd.DataFrame:
    """
    东方财富网-沪深京 A 股-实时行情
    https://quote.eastmoney.com/center/gridlist.html#hs_a_board

    东方财富-ETF 实时行情
    https://quote.eastmoney.com/center/gridlist.html#fund_etf

    东方财富网-行情中心-上证系列指数
    https://quote.eastmoney.com/center/gridlist.html#index_sh

    东方财富网-行情中心-深证系列指数
    https://quote.eastmoney.com/center/gridlist.html#index_sz

    """
    # 市场与编码
    market_dict = {
        '沪深京A': 'm:0+t:6+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2,m:0+t:81+s:262144+f:!2',
        'ETF': 'b:MK0021,b:MK0022,b:MK0023,b:MK0024,b:MK0827', 
        '上证系列指数': 'm:1+t:1',
        '深证系列指数': 'm:0+t:5',
        }

    fs = market_dict.get(market, market_dict['沪深京A'])

    # 分页参数
    page_size = 100  # 每页最大返回100条
    url = 'https://push2.eastmoney.com/api/qt/clist/get'

    base_params = {
        'np': '1',
        'fltt': '1',
        'invt': '2',
        'fs': fs,
        'fields': ','.join(trade_detail_dict.keys()),
        'fid': 'f3',
        'pn': '1',
        'pz': str(page_size),
        'po': '1',
        'dect': '1',
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        'wbp2u': '|0|0|0|web',
    }

    merged_diff: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        # 先请求第一页，动态计算总页数，再执行后续分页拉取
        page_number = 1
        logger.info(f"实时行情： {market} -> 第 {page_number} 页")
        first_page_data = await _fetch_json(url, base_params, timeout, client)
        first_data = first_page_data.get('data') or {}
        first_diff = first_data.get('diff') or []
        if not first_diff:
            logger.info(f"实时行情： {market} -> 未获取到数据！")
            return pd.DataFrame(columns=list(trade_detail_dict.values()) + ['市场'])

        merged_diff.extend(first_diff)
        total = int(first_data.get('total') or 0)
        page_size_safe = max(int(base_params['pz']), 1)
        total_page = max((total + page_size_safe - 1) // page_size_safe, 1)

        page_number = 2
        while page_number <= total_page:
            params = dict(base_params)
            params['pn'] = str(page_number)
            logger.info(f"实时行情： {market} -> 第 {page_number} 页，共 {total_page} 页")
            page_data = await _fetch_json(url, params, timeout, client)
            page_diff = ((page_data.get('data') or {}).get('diff') or [])
            if not page_diff:
                # 返回空页时提前退出，避免无效请求
                break
            merged_diff.extend(page_diff)
            page_number += 1

    if not merged_diff:
        return pd.DataFrame(columns=list(trade_detail_dict.values()) + ['市场'])

    df_total = pd.DataFrame(merged_diff)
    # 数据清洗和转换
    df_total = df_total.rename(columns=trade_detail_dict)
    df_total = df_total.reindex(columns=list(trade_detail_dict.values()))
    df_total['市场'] = df_total['编号'].astype(str).apply(lambda x: market_num_dict.get(x))
    # df = df.drop(columns=['编号'])
    return trans_num(df_total, ignore_cols=['代码', '名称', '时间', '市场', '编号'])


async def get_1min_data(code: str, n: int = 5) -> pd.DataFrame:
    """获取最近 n 日 1 分钟行情（最多 5 个交易日）。"""
    code_id = await get_code_id(code)
    if not code_id:
        return pd.DataFrame(columns=['name', 'code', 'open', 'high', 'low', 'close', 'vol', 'turnover'])

    n = min(max(int(n), 1), 5)
    params = {
        'fields1': 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
        'fields2': 'f51,f52,f53,f54,f55,f56,f57',
        'ndays': str(n),
        'iscr': '0',
        'iscca': '0',
        'secid': code_id,
    }

    url = 'http://push2his.eastmoney.com/api/qt/stock/trends2/get'
    res = await _fetch_json(url, params)
    lines = ((res.get('data') or {}).get('trends') or [])
    if not lines:
        return pd.DataFrame(columns=['name', 'code', 'open', 'high', 'low', 'close', 'vol', 'turnover'])

    cols = ['date', 'open', 'close', 'high', 'low', 'vol', 'turnover']
    df = pd.DataFrame([item.split(',') for item in lines], columns=cols)
    df.insert(0, 'code', code_id.split('.')[-1])
    df.insert(0, 'name', (res.get('data') or {}).get('name'))
    df.index = pd.to_datetime(df['date'], errors='coerce')
    df = df[['name', 'code', 'open', 'high', 'low', 'close', 'vol', 'turnover']]
    return trans_num(df, ignore_cols=['name', 'code'])


async def get_data(
    code: str,
    start_date: str = '19700101',
    end_date: str = '20500101',
    period: str = "daily",
    adjust: str = 'qfq',
) -> pd.DataFrame:
    """
    东方财富网-行情首页-沪深京 A 股-每日行情
    https://quote.eastmoney.com/concept/sh603777.html?from=classic

    获取股票、指数、债券、期货、基金等历史K线行情
    code可以是股票或指数（包括美股港股等）代码或简称
    start和end为起始和结束日期，年月日
    freq:时间频率，默认日，1 : 分钟；5 : 5 分钟；15 : 15 分钟；30 : 30 分钟；60 : 60 分钟；101或'D'或'd'：日；102或‘w’或'W'：周; 103或'm'或'M': 月
    注意1分钟只能获取最近5个交易日一分钟数据
    adjust:复权类型，{"qfq": "前复权", "hfq": "后复权", "": "不复权"}
    """
    p = str(period).lower()
    period_dict = {'daily': '101', 'weekly': '102', 'monthly': '103', 'd': '101', 'w': '102', 'm': '103'}
    p = period_dict.get(p, p)

    adjust_dict = {'': '0', 'qfq': '1', 'hfq': '2', 'none': '0'}
    fqt = adjust_dict.get(str(adjust).lower(), '0')

    if p == '1':
        return await get_1min_data(code)

    code_id = await get_code_id(code)
    if not code_id:
        logger.error(f"未找到代码 {code} 的对应 ID，无法获取数据。")
        return pd.DataFrame()

    params = {
        'fields1': 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13',
        'fields2': 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
        "ut": "7eea3edcaed734bea9cbfc24409ed989",
        # 'rtntype': '6',
        'klt': p,
        'fqt': fqt,
        'secid': code_id,
        'beg': '0' if p in {'5', '15', '30', '60'} else start_date,
        'end': '20500000' if p in {'5', '15', '30', '60'} else end_date,
    }

    url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    json_response = await _fetch_json(url, params)
    lines = ((json_response.get('data') or {}).get('klines') or [])
    if not lines:
        return pd.DataFrame(columns=['name', 'code', 'open', 'high', 'low', 'close', 'volume', 'turnover', 'turnover_rate'])

    cols = ['datetime', 'open', 'close', 'high', 'low', 'volume', 'turnover', 'amplitude', 'change_pct', 'change_amt', 'turnover_rate']
    df = pd.DataFrame([item.split(',') for item in lines], columns=cols)
    df.insert(0, 'code', code_id.split('.')[-1])
    df.insert(0, 'name', (json_response.get('data') or {}).get('name'))

    if p in {'5', '15', '30', '60'}:
        idx = pd.to_datetime(df['datetime'], errors='coerce')
        start_dt = pd.to_datetime(start_date)
        end_dt = pd.to_datetime(end_date)
        df = df[(idx >= start_dt) & (idx <= end_dt)]

    df.index = pd.to_datetime(df['datetime'], errors='coerce')
    df = df[['name', 'code', 'open', 'high', 'low', 'close', 'volume', 'turnover', 'turnover_rate']]
    return trans_num(df, ignore_cols=['name', 'code'])


class EastmoneyMarket:
    """东方财富行情实现类（qstock 风格异步实现）。"""

    async def warmup_session(self, force_refresh: bool = False) -> bool:
        """在正式抓数前预热浏览器会话。默认仅在 Cookie 过旧时刷新。"""
        return await warmup_eastmoney_session(force_refresh=force_refresh)

    async def get_history(
        self,
        symbol: str,
        period: str | int = 'daily',
        start_date: str = '19700101',
        end_date: str = '20500101',
        adjust: str = '',
        timeout: float | None = None,
    ) -> pd.DataFrame:
        return await get_data(
            code=symbol,
            start_date=start_date,
            end_date=end_date,
            period=period,
            adjust=adjust,
        )

    async def get_histories(
        self,
        symbols: list[str],
        period: str | int = "daily",
        start_date: str = "19700101",
        end_date: str = "20500101",
        adjust: str = "",
        timeout: float | None = None,
    ) -> dict[str, pd.DataFrame]:
        """并发获取多个标的历史行情。"""
        tasks = [
            self.get_history(
                symbol=symbol,
                period=period,
                start_date=start_date,
                end_date=end_date,
                adjust=adjust,
                timeout=timeout,
            )
            for symbol in symbols
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return {
            symbol: (result if isinstance(result, pd.DataFrame) else pd.DataFrame())
            for symbol, result in zip(symbols, results)
        }
    
    async def get_spot(self, market: str) -> pd.DataFrame:
        return await market_realtime(market)


if __name__ == "__main__":
    import asyncio

    async def main():
        market = EastmoneyMarket()
        print(get_eastmoney_session_status())
        await market.warmup_session()
        df_history = await market.get_history('平安银行', period='daily', adjust='hfq', start_date='20260320')
        print(df_history)

    asyncio.run(main())
