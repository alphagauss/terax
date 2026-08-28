"""测试 Alpha 市场元数据的交易所权威映射。"""

from alpha.common.market_metadata import get_market_metadata


def test_china_exchange_uses_local_market_conventions() -> None:
    """中国内地交易所应返回统一时区、红涨绿跌和股数单位。"""
    metadata = get_market_metadata("000001.SZSE")

    assert metadata.timezone.key == "Asia/Shanghai"
    assert metadata.price_color_convention == "up-red"
    assert metadata.volume_unit == "share"


def test_hong_kong_exchange_uses_its_own_iana_timezone() -> None:
    """香港交易所必须返回香港 IANA 时区而不是前端推断值。"""
    metadata = get_market_metadata("0700.HKEX")

    assert metadata.timezone.key == "Asia/Hong_Kong"
    assert metadata.price_color_convention == "up-red"
