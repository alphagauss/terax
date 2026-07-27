from pathlib import Path
import pandas as pd
from functools import lru_cache

from alpha.common.paths import get_runtime_subdir

FOLDER_NAME = "csv_db"

trade_date_name = "trade_date.csv"

symbol_info_map = [
    {
        "name":"gm_a_share_stock_infos",  # 查询 A 股股票
        "sec_type1":1010,
        "sec_type2":101001
    },
    {
        "name":"gm_a_share_etf_infos",    # 查询 A 股 ETF
        "sec_type1":1020,
        "sec_type2":102001
    },
    {
        "name":"gm_a_share_idx_infos",    # 查询 A 股 指数
        "sec_type1":1060,
        "sec_type2":106001
    }
]


@lru_cache()
def get_csvdb_folder() -> Path:
    return get_runtime_subdir(FOLDER_NAME)


def save_csv(df: pd.DataFrame, name: str) -> None:
    """保存数据到 CSV 文件。

    默认使用 ``utf-8-sig`` 编码，便于在常见表格软件中直接查看中文表头。
    """
    folder_path = get_csvdb_folder()
    file_path = folder_path.joinpath(f"{name}.csv")
    df.to_csv(file_path, index=False, encoding="utf-8-sig")


def load_csv(name: str) -> pd.DataFrame:
    """读取 CSV 文件。"""
    folder_path = get_csvdb_folder()
    file_path = folder_path.joinpath(f"{name}.csv")
    return pd.read_csv(file_path, encoding="utf-8-sig")

def save_trade_date(df: pd.DataFrame):
    """
    有4列，date,next_trade_date,pre_trade_date,trade_date
    """
    file_path = get_csvdb_folder().joinpath(trade_date_name)
    df.to_csv(file_path, index=False, encoding="utf-8-sig")

def get_trade_date() -> pd.DataFrame:
    """
    获取交易日历
    """
    file_path = get_csvdb_folder().joinpath(trade_date_name)
    return pd.read_csv(file_path, encoding="utf-8-sig")

def get_a_share_infos():
    """
    获取A股股票、ETF基金、指数的 信息（含退市）
    """
    folder_path = get_csvdb_folder()

    results = {}
    for item in symbol_info_map:
        file_path = folder_path.joinpath(f"{item['name']}.csv")
        df = pd.read_csv(file_path)
        results[item['name']] = df
    
    return results
        




