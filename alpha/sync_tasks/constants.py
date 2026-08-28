from __future__ import annotations

from datetime import date

SYNC_FIELDS = "symbol,eob,open,high,low,close,volume,amount"
MAX_HISTORY_ROWS_PER_REQUEST = 30000
YEAR_BUFFER_FLUSH_ROWS = 100000
MAX_QUALITY_ISSUES = 100
MAX_QUALITY_RETRY_SYMBOLS = 500
DEFAULT_START_DATE = date(2005, 1, 1)
LOG_FOLDER_NAME = "logs"
SECURITY_SYNC_FACTOR_FLUSH_ROWS = 50000
SECURITY_GROUP_CONFIGS = (
    {"asset_type": "stock", "sec_type1": 1010, "sec_type2": 101001},
    {"asset_type": "etf", "sec_type1": 1020, "sec_type2": 102001},
    {"asset_type": "index", "sec_type1": 1060, "sec_type2": 106001},
)
