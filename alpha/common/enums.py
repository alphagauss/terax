from enum import Enum


class Interval(Enum):
    """ Interval of bar data(Enum). """
    MINUTE = "1m"
    HOUR = "1h"
    DAILY = "d"
    WEEKLY = "w"
    TICK = "tick"
    
    @classmethod
    def is_valid(cls, value: str) -> bool:
        return value in cls._value2member_map_
    
class StopOrderStatus(Enum):
    WAITING = "等待中"
    CANCELLED = "已撤销"
    TRIGGERED = "已触发"


class EngineType(Enum):
    LIVE = "实盘"
    BACKTESTING = "回测"


class BacktestingMode(Enum):
    BAR = 1
    TICK = 2


class Exchange(Enum):
    """Exchange(Enum). """
    # Chinese
    SSE = "SSE"             # 上海证券交易所 Shanghai Stock Exchange
    SZSE = "SZSE"           # 深圳证券交易所 Shenzhen Stock Exchange
    BSE = "BSE"             # 北京证券交易所 Beijing Stock Exchange
    HKEX = "HKEX"           # 香港证券交易所 Hong Kong Exchanges and Clearing Limited

    @classmethod
    def is_valid(cls, value: str) -> bool:
        return value in cls._value2member_map_

class Direction(Enum):
    """
    Direction of order/trade/position.
    """
    LONG = "多"
    SHORT = "空"
    NET = "净" # 净头寸, 指所持有的 多头持仓量减去空头持仓量 的净值，如A股，一个账户每个品种只能有一个方向的总持仓


class Offset(Enum):
    """
    Offset of order/trade.
    """
    NONE = ""
    OPEN = "开"
    CLOSE = "平"
    CLOSETODAY = "平今"
    CLOSEYESTERDAY = "平昨"

class Status(Enum):
    """
    Order status.
    """
    SUBMITTING = "提交中"
    NOTTRADED = "未成交"
    PARTTRADED = "部分成交"
    ALLTRADED = "全部成交"
    CANCELLED = "已撤销"
    REJECTED = "拒单"

class Product(Enum):
    """
    Product class.
    """
    ASHARE = "A股"
    EQUITY = "股票"
    FUTURES = "期货"
    OPTION = "期权"
    INDEX = "指数"
    FOREX = "外汇"
    SPOT = "现货"
    ETF = "ETF"
    BOND = "债券"
    WARRANT = "权证"
    SPREAD = "价差"
    FUND = "基金"


class OrderType(Enum):
    """
    Order type.
    """
    LIMIT = "限价"   # 限价单,  设置一个指定的价格来买入或卖出, 买入限价单以设定的价格（或更低）买入， 卖出限价单以设定的价格（或更高）卖出
    MARKET = "市价"  # 市价单,  以当前市场上最优价格立即成交, 买入市价单会以当前最优卖价成交, 卖出市价单会以当前最优买价成交
    STOP = "STOP"    # 止损单， 当市场价格达到一个预先设定的“触发价格”时， 才会将订单激活并以市价或者限价方式下单
    FAK = "FAK"      # Fill And Kill， 立即成交剩余撤销单， 订单提交后，能成交的部分立即成交，不能成交的部分立即取消。
    FOK = "FOK"      # Fill Or Kill， 全部成交否则撤销单， 订单必须一次性全部成交，否则将立即全部取消。
    RFQ = "询价"     # Request For Quote， 询价单， 向交易对手或做市商发出“请求报价”的操作，等待对方给出买入/卖出价格。交易者收到报价后可以选择是否接受并成交。

class OptionType(Enum):
    """
    Option type.
    """
    CALL = "看涨期权"
    PUT = "看跌期权"

ACTIVE_STATUSES = set([Status.SUBMITTING, Status.NOTTRADED, Status.PARTTRADED])


