from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime as _datetime

from alpha.common.enums import (
    ACTIVE_STATUSES,
    Direction,
    Exchange,
    Offset,
    OptionType,
    OrderType,
    Product,
    Status,
    StopOrderStatus,
    Interval,
)


@dataclass
class OrderData:
    """
    Order data contains information for tracking lastest status
    of a specific order.
    """

    gateway_name: str
    vt_symbol: str
    orderid: str

    order_type: OrderType = OrderType.LIMIT
    direction: Direction = None
    offset: Offset = Offset.NONE
    price: float = 0
    volume: float = 0
    traded_volume: float = 0
    status: Status | StopOrderStatus = Status.SUBMITTING
    reference: str = ""
    vt_stop_order_orderids: list = field(default_factory=list)

    def __post_init__(self) -> None:
        """补全订单级派生字段。"""
        self.vt_orderid: str = f"{self.gateway_name}.{self.orderid}"
        if self.order_type == OrderType.STOP:
            self.status = StopOrderStatus.WAITING

    def is_active(self) -> bool:
        """判断订单是否仍处于活跃状态。"""
        return self.status in ACTIVE_STATUSES

    def create_cancel_request(self) -> "CancelRequest":
        """从订单对象生成撤单请求。"""
        req: CancelRequest = CancelRequest(
            orderid=self.orderid,
            vt_symbol=self.vt_symbol,
        )
        return req


@dataclass
class TradeData:
    """
    Trade data contains information of a fill of an order. One order
    can have several trade fills.
    """

    gateway_name: str
    vt_symbol: str
    orderid: str
    tradeid: str
    direction: Direction = None

    offset: Offset = Offset.NONE
    price: float = 0
    volume: float = 0
    datetime: _datetime = None

    slippage: float = 0
    commission: float = 0

    def __post_init__(self) -> None:
        """补全成交对象的派生标识字段。"""
        self.vt_orderid: str = f"{self.gateway_name}.{self.orderid}"
        self.vt_tradeid: str = f"{self.gateway_name}.{self.tradeid}"

    def update_cost(self, slippage: float, commission: float) -> None:
        """更新交易成本。"""
        self.slippage = slippage
        self.commission = commission


@dataclass
class CancelRequest:
    """发送给交易网关的撤单请求。"""

    orderid: str
    vt_symbol: str


@dataclass
class StopOrder:
    """止损单。"""

    vt_symbol: str
    direction: Direction
    offset: Offset
    price: float
    volume: float
    stop_orderid: str
    strategy_name: str
    datetime: _datetime
    lock: bool = False
    net: bool = False
    vt_orderids: list = field(default_factory=list)
    status: StopOrderStatus = StopOrderStatus.WAITING


@dataclass
class ContractData:
    """合约静态信息。"""

    gateway_name: str
    vt_symbol: str
    name: str
    product: Product
    size: int
    pricetick: float

    rate: float = 0
    slippage: float = 0
    stamps: float = 0
    min_commission: float = 0

    min_volume: float = 1
    stop_supported: bool = False
    net_position: bool = True
    history_data: bool = False

    option_strike: float = 0
    option_underlying: str = ""
    option_type: OptionType = None
    option_listed: _datetime = None
    option_expiry: _datetime = None
    option_portfolio: str = ""
    option_index: str = ""



@dataclass
class QuoteData:
    """报价对象。"""

    gateway_name: str
    vt_symbol: str
    quoteid: str

    bid_price: float = 0.0
    bid_volume: int = 0
    ask_price: float = 0.0
    ask_volume: int = 0
    bid_offset: Offset = Offset.NONE
    ask_offset: Offset = Offset.NONE
    status: Status = Status.SUBMITTING
    datetime: _datetime = None
    reference: str = ""

    def __post_init__(self) -> None:
        """补全报价级派生标识字段。"""
        self.vt_quoteid: str = f"{self.gateway_name}.{self.quoteid}"

    def is_active(self) -> bool:
        """判断报价是否仍处于活跃状态。"""
        return self.status in ACTIVE_STATUSES

    def create_cancel_request(self) -> "CancelRequest":
        """从报价对象生成撤单请求。"""
        req: CancelRequest = CancelRequest(
            orderid=self.quoteid,
            vt_symbol=self.vt_symbol,
        )
        return req


@dataclass
class LogData:
    """日志对象。"""

    gateway_name: str
    msg: str
    level: str = "INFO"

    def __post_init__(self) -> None:
        """记录日志创建时间。"""
        self.time: _datetime = _datetime.now()



@dataclass
class OrderRequest:
    """下单请求。"""

    vt_symbol: str
    direction: Direction
    order_type: OrderType
    volume: float

    price: float = 0
    offset: Offset = Offset.NONE
    reference: str = ""
    lock: bool = False
    net: bool = False


    def create_order_data(self, orderid: str, gateway_name: str) -> OrderData:
        """从请求对象生成订单对象。"""
        order: OrderData = OrderData(
            gateway_name=gateway_name,
            vt_symbol=self.vt_symbol,
            orderid=orderid,
            order_type=self.order_type,
            direction=self.direction,
            offset=self.offset,
            price=self.price,
            volume=self.volume,
            reference=self.reference,
        )
        return order



@dataclass
class QuoteRequest:
    """报价请求。"""

    vt_symbol: str
    bid_price: float
    bid_volume: int
    ask_price: float
    ask_volume: int
    bid_offset: Offset = Offset.NONE
    ask_offset: Offset = Offset.NONE
    reference: str = ""


    def create_quote_data(self, quoteid: str, gateway_name: str) -> QuoteData:
        """从请求对象生成报价对象。"""
        quote: QuoteData = QuoteData(
            vt_symbol=self.vt_symbol,
            quoteid=quoteid,
            bid_price=self.bid_price,
            bid_volume=self.bid_volume,
            ask_price=self.ask_price,
            ask_volume=self.ask_volume,
            bid_offset=self.bid_offset,
            ask_offset=self.ask_offset,
            reference=self.reference,
            gateway_name=gateway_name,
        )
        return quote
