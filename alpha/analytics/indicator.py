"""Alpha 回测与图表共用的 TA-Lib 技术指标数组计算内核。"""

import talib
import numpy as np
from numpy import ndarray


class Indicators:
    @staticmethod
    def _pick(result: ndarray, array: bool) -> float | ndarray:
        """
        根据数组标志选择返回整个数组或最后一个元素

        Args:
            result (ndarray): 输入的数值数组
            array (bool): 是否返回整个数组的标志。True返回整个数组，False返回最后一个元素

        Returns:
            float | ndarray: 根据array参数返回整个数组或最后一个元素值
        """
        return result if array else result[-1]

    @staticmethod
    def _pick_tuple(*results: ndarray, array: bool) -> tuple:
        """
        处理多个技术指标结果的元组版本，根据需求返回完整数组或最新值

        Args:
            *results (ndarray): 可变数量的技术指标数组
            array (bool): 控制返回类型
                True: 返回完整数组
                False: 返回各数组最后一个元素组成的元组

        Returns:
            tuple: 当array=True时返回原始结果元组，否则返回各数组最新值组成的元组
        """
        return results if array else tuple(result[-1] for result in results)

    @staticmethod
    def sma(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """Simple moving average."""
        return Indicators._pick(talib.SMA(close, n), array)

    @staticmethod
    def ema(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """Exponential moving average."""
        return Indicators._pick(talib.EMA(close, n), array)

    @staticmethod
    def kama(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """KAMA."""
        return Indicators._pick(talib.KAMA(close, n), array)

    @staticmethod
    def wma(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """WMA."""
        return Indicators._pick(talib.WMA(close, n), array)

    @staticmethod
    def apo(
        close: ndarray,
        fast_period: int,
        slow_period: int,
        matype: int = 0,
        array: bool = True,
    ) -> float | ndarray:
        """APO."""
        return Indicators._pick(talib.APO(close, fast_period, slow_period, matype), array)

    @staticmethod
    def cmo(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """CMO."""
        return Indicators._pick(talib.CMO(close, n), array)

    @staticmethod
    def mom(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """MOM."""
        return Indicators._pick(talib.MOM(close, n), array)

    @staticmethod
    def ppo(
        close: ndarray,
        fast_period: int,
        slow_period: int,
        matype: int = 0,
        array: bool = True,
    ) -> float | ndarray:
        """PPO."""
        return Indicators._pick(talib.PPO(close, fast_period, slow_period, matype), array)

    @staticmethod
    def roc(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """ROC."""
        return Indicators._pick(talib.ROC(close, n), array)

    @staticmethod
    def rocr(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """ROCR."""
        return Indicators._pick(talib.ROCR(close, n), array)

    @staticmethod
    def rocp(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """ROCP."""
        return Indicators._pick(talib.ROCP(close, n), array)

    @staticmethod
    def rocr_100(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """ROCR100."""
        return Indicators._pick(talib.ROCR100(close, n), array)

    @staticmethod
    def trix(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """TRIX."""
        return Indicators._pick(talib.TRIX(close, n), array)

    @staticmethod
    def std(close: ndarray, n: int, nbdev: int = 1, array: bool = True) -> float | ndarray:
        """Standard deviation."""
        return Indicators._pick(talib.STDDEV(close, n, nbdev), array)

    @staticmethod
    def obv(close: ndarray, volume: ndarray, array: bool = True) -> float | ndarray:
        """OBV."""
        return Indicators._pick(talib.OBV(close, volume), array)

    @staticmethod
    def cci(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """Commodity Channel Index (CCI)."""
        return Indicators._pick(talib.CCI(high, low, close, n), array)

    @staticmethod
    def atr(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """Average True Range (ATR)."""
        return Indicators._pick(talib.ATR(high, low, close, n), array)

    @staticmethod
    def natr(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """NATR."""
        return Indicators._pick(talib.NATR(high, low, close, n), array)

    @staticmethod
    def rsi(close: ndarray, n: int, array: bool = True) -> float | ndarray:
        """Relative Strenght Index (RSI)."""
        return Indicators._pick(talib.RSI(close, n), array)

    @staticmethod
    def macd(
        close: ndarray,
        fast_period: int,
        slow_period: int,
        signal_period: int,
        array: bool = True,
    ) -> tuple[ndarray, ndarray, ndarray] | tuple[float, float, float]:
        """MACD."""
        return Indicators._pick_tuple(
            *talib.MACD(close, fast_period, slow_period, signal_period),
            array=array,
        )

    @staticmethod
    def adx(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """ADX."""
        return Indicators._pick(talib.ADX(high, low, close, n), array)

    @staticmethod
    def adxr(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """ADXR."""
        return Indicators._pick(talib.ADXR(high, low, close, n), array)

    @staticmethod
    def dx(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """DX."""
        return Indicators._pick(talib.DX(high, low, close, n), array)

    @staticmethod
    def minus_di(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """MINUS_DI."""
        return Indicators._pick(talib.MINUS_DI(high, low, close, n), array)

    @staticmethod
    def plus_di(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """PLUS_DI."""
        return Indicators._pick(talib.PLUS_DI(high, low, close, n), array)

    @staticmethod
    def willr(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """WILLR."""
        return Indicators._pick(talib.WILLR(high, low, close, n), array)

    @staticmethod
    def ultosc(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        time_period1: int = 7,
        time_period2: int = 14,
        time_period3: int = 28,
        array: bool = True,
    ) -> float | ndarray:
        """Ultimate Oscillator."""
        return Indicators._pick(
            talib.ULTOSC(high, low, close, time_period1, time_period2, time_period3),
            array,
        )

    @staticmethod
    def trange(close: ndarray, high: ndarray, low: ndarray, array: bool = True) -> float | ndarray:
        """TRANGE."""
        return Indicators._pick(talib.TRANGE(high, low, close), array)

    @staticmethod
    def boll(close: ndarray, n: int, dev: float, array: bool = True) -> tuple[ndarray, ndarray] | tuple[float, float]:
        """Bollinger Channel."""
        up, _, down = Indicators.boll_full(close, n, dev)
        return Indicators._pick_tuple(up, down, array=array)

    @staticmethod
    def boll_full(
        close: ndarray,
        n: int,
        dev: float,
        array: bool = True,
    ) -> tuple[ndarray, ndarray, ndarray] | tuple[float, float, float]:
        """一次计算并返回布林通道的上轨、中轨和下轨。"""
        mid = talib.SMA(close, n)
        std = talib.STDDEV(close, n, 1)
        up = mid + std * dev
        down = mid - std * dev
        return Indicators._pick_tuple(up, mid, down, array=array)

    @staticmethod
    def keltner(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        dev: float,
        array: bool = True,
    ) -> tuple[ndarray, ndarray] | tuple[float, float]:
        """Keltner Channel."""
        mid = talib.SMA(close, n)
        atr = talib.ATR(high, low, close, n)
        up = mid + atr * dev
        down = mid - atr * dev
        return Indicators._pick_tuple(up, down, array=array)

    @staticmethod
    def donchian(close: ndarray, n: int, array: bool = True) -> tuple[ndarray, ndarray] | tuple[float, float]:
        """Donchian Channel."""
        up = talib.MAX(close, n)
        down = talib.MIN(close, n)
        return Indicators._pick_tuple(up, down, array=array)

    @staticmethod
    def aroon(high: ndarray, low: ndarray, n: int, array: bool = True) -> tuple[ndarray, ndarray] | tuple[float, float]:
        """Aroon indicator."""
        aroon_down, aroon_up = talib.AROON(high, low, n)
        return Indicators._pick_tuple(aroon_up, aroon_down, array=array)

    @staticmethod
    def aroonosc(high: ndarray, low: ndarray, n: int, array: bool = True) -> float | ndarray:
        """Aroon Oscillator."""
        return Indicators._pick(talib.AROONOSC(high, low, n), array)

    @staticmethod
    def minus_dm(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """MINUS_DM."""
        return Indicators._pick(talib.MINUS_DM(high, low, close, n), array)

    @staticmethod
    def plus_dm(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """PLUS_DM."""
        return Indicators._pick(talib.PLUS_DM(high, low, close, n), array)

    @staticmethod
    def mfi(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        volume: ndarray,
        n: int,
        array: bool = True,
    ) -> float | ndarray:
        """Money Flow Index."""
        return Indicators._pick(talib.MFI(high, low, close, volume, n), array)

    @staticmethod
    def ad(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        volume: ndarray,
        array: bool = True,
    ) -> float | ndarray:
        """AD."""
        return Indicators._pick(talib.AD(high, low, close, volume), array)

    @staticmethod
    def adosc(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        volume: ndarray,
        fast_period: int,
        slow_period: int,
        array: bool = True,
    ) -> float | ndarray:
        """ADOSC."""
        return Indicators._pick(
            talib.ADOSC(high, low, close, volume, fast_period, slow_period),
            array,
        )

    @staticmethod
    def bop(
        open: ndarray,
        high: ndarray,
        low: ndarray,
        close: ndarray,
        array: bool = True,
    ) -> float | ndarray:
        """BOP."""
        return Indicators._pick(talib.BOP(open, high, low, close), array)

    @staticmethod
    def stoch(
        close: ndarray,
        high: ndarray,
        low: ndarray,
        fastk_period: int,
        slowk_period: int,
        slowk_matype: int,
        slowd_period: int,
        slowd_matype: int,
        array: bool = True,
    ) -> tuple[float, float] | tuple[ndarray, ndarray]:
        """Stochastic Indicator."""
        return Indicators._pick_tuple(
            *talib.STOCH(
                high,
                low,
                close,
                fastk_period,
                slowk_period,
                slowk_matype,
                slowd_period,
                slowd_matype,
            ),
            array=array,
        )


def compare_speed(n: int = 100_000_000, timeperiod: int = 20, repeat: int = 5):
    """
    比较自定义SMA与TA-Lib的速度差异
    :param n: 数据长度
    :param timeperiod: 滑动窗口
    :param repeat: 重复次数以取平均
    """
    import time

    data = np.random.random(n).astype(float)

    # SMA耗时
    t1 = []
    for _ in range(repeat):
        start = time.perf_counter()
        Indicators.sma(data, timeperiod)
        t1.append(time.perf_counter() - start)
    avg_custom = np.mean(t1)

    # EMA耗时
    t2 = []
    for _ in range(repeat):
        start = time.perf_counter()
        Indicators.ema(data, timeperiod)
        t2.append(time.perf_counter() - start)
    avg_talib = np.mean(t2)

    print(f"数据量: {n:,}，窗口: {timeperiod}")
    print(f"SMA平均耗时: {avg_custom:.6f} 秒")
    print(f" EMA平均耗时: {avg_talib:.6f} 秒")
    print(f"速度比: SMA / EMA = {avg_custom / avg_talib:.3f}x")


if __name__ == "__main__":
    compare_speed()
