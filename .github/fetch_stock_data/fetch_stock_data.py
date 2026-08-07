import os
import sys
import pathlib
import argparse
import json
import math
import time
import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

DELAY_TIME_SEC = 0.5
RETRY_FAILED_DELAY = 10
RETRY_CNT = 3

# Sector/Industry name -> index maps, mirroring StockSectorDict/StockIndustryDict
# in the front-end (src/common/stockdef.js). Unknown names fall back to "-1".
SECTOR_INDEX = {
    "Technology": "0",
    "Industrials": "1",
    "Financial Services": "2",
    "Consumer Cyclical": "3",
    "Communication Services": "4",
    "Healthcare": "5",
    "Real Estate": "6",
    "Basic Materials": "7",
    "Consumer Defensive": "8",
    "Utilities": "9",
    "Energy": "10",
}

INDUSTRY_INDEX = {}


def load_industry_index():
    """Build industry name -> index map from the front-end StockIndustryDict."""
    global INDUSTRY_INDEX
    root = pathlib.Path(__file__).parent.resolve()
    stockdef_path = root / ".." / ".." / "src" / "common" / "stockdef.js"
    try:
        content = stockdef_path.read_text(encoding="utf-8")
        start = content.find("StockIndustryDict")
        if start == -1:
            return
        brace = content.find("{", start)
        if brace == -1:
            return
        # crude but effective: extract "key": "Name" pairs
        import re
        pairs = re.findall(r'"(\d+)"\s*:\s*"([^"]+)"', content[brace:])
        for key, name in pairs:
            INDUSTRY_INDEX[name] = key
    except Exception as ex:
        print("load_industry_index failed: {ex}".format(ex=ex))


def is_float(value):
    try:
        float(value)
        return True
    except (ValueError, TypeError):
        return False


def fmt_num(v):
    if v is None:
        return "-"
    try:
        f = float(v)
    except (ValueError, TypeError):
        return "-"
    if math.isnan(f) or math.isinf(f):
        return "-"
    return f


def pct_decimal(v):
    """Convert a raw yfinance value to a decimal fraction (e.g. 0.2133 for 21.33%).
    yfinance info returns ratios like 0.2133 already; keep them as-is. If it came
    back oddly large (>1 for a percentage we expect <1, or >10 for a ratio) still
    pass through and let the front-end interpret."""
    return fmt_num(v)


NASDAQ_TRADER_BASE = "https://www.nasdaqtrader.com/dynamic/SymDir/"


def _parse_nasdaq_symbols(content, is_nasdaq):
    """Parse NASDAQ Trader symboldirectory txt into symbol list."""
    symbols = []
    for line in content.splitlines():
        if line.startswith("Symbol"):
            continue
        parts = line.split("|")
        if len(parts) < 2:
            continue
        symbol = parts[0].strip()
        test_issue = parts[1].strip()
        if is_nasdaq and test_issue != "Y":
            continue
        # filter to common stocks: exclude ETF, preferred, etc. is done later
        if symbol.isalpha() and symbol != "":
            symbols.append(symbol)
    return symbols


def get_stock_universe():
    """Return the list of US stock symbols to scan.
    Priority: CLI arg -> env var -> NASDAQ Trader official symbol directory
    (nasdaq + other exchanges), with a repo-cached fallback."""
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "-input-symbol-list", dest="input", default="")
    args, _ = parser.parse_known_args()
    if args.input:
        return [s.strip() for s in args.input.split(",") if s.strip()]

    env_list = os.environ.get("STOCK_SYMBOLS", "")
    if env_list:
        return [s.strip() for s in env_list.split(",") if s.strip()]

    # repo-cached fallback list (avoids network entirely when present)
    root = pathlib.Path(__file__).parent.resolve()
    cache_file = root / ".." / ".." / "static" / "stock_symbols.txt"
    if cache_file.exists():
        cached = [s.strip() for s in cache_file.read_text(encoding="utf-8").splitlines() if s.strip()]
        if cached:
            print("using cached symbol list: {n} symbols".format(n=len(cached)))
            return cached

    try:
        symbols = []
        for fname, is_nasdaq in [("nasdaqlisted.txt", True), ("otherlisted.txt", False)]:
            resp = requests.get(NASDAQ_TRADER_BASE + fname, timeout=30)
            resp.raise_for_status()
            symbols += _parse_nasdaq_symbols(resp.text, is_nasdaq)
        # dedupe
        symbols = list(dict.fromkeys(symbols))
        print("using NASDAQ Trader symbol directory: {n} symbols".format(n=len(symbols)))
        return symbols
    except Exception as ex:
        print("NASDAQ Trader symbol directory failed: {ex}".format(ex=ex))
        return []


def get_stock_1y_data_from_yahoo(symbol):
    try:
        stock = yf.Ticker(symbol)
        hist = stock.history(period="1y")
        if hist is None or hist.empty:
            return None
        output = []
        for index, row in hist.iterrows():
            d = {"Date": index.strftime("%m/%d/%Y"), "Open": row["Open"], "High": row["High"], "Low": row["Low"],
                 "Close": row["Close"], "Volume": row["Volume"]}
            output.append(d)
        output.reverse()
        return output
    except Exception as ex:
        print('Generated an exception: {ex}'.format(ex=ex))
    return None


def compute_performance(hist_data):
    """Given 1y daily closes (oldest first), compute the perf fields as decimals."""
    out = {"Perf Week": "-", "Perf Month": "-", "Perf Quarter": "-", "Perf Half Y": "-", "Perf Year": "-", "Perf YTD": "-"}
    if not hist_data or len(hist_data) < 2:
        return out
    closes = [d["Close"] for d in hist_data]
    today = closes[-1]
    dates = [d["Date"] for d in hist_data]
    now = datetime.now()
    try:
        ytd_date = datetime(now.year, 1, 1)
        anchors = {"Perf Week": 5, "Perf Month": 21, "Perf Quarter": 63, "Perf Half Y": 126, "Perf Year": 250}
        for name, n in anchors.items():
            idx = len(closes) - 1 - n
            if idx >= 0 and closes[idx] != 0:
                out[name] = fmt_num(today / closes[idx] - 1)
        # YTD
        for d, c in zip(dates, closes):
            dt = datetime.strptime(d, "%m/%d/%Y")
            if dt >= ytd_date and c != 0:
                out["Perf YTD"] = fmt_num(today / c - 1)
                break
    except Exception as ex:
        print('compute_performance exception: {ex}'.format(ex=ex))
    return out


def compute_ma_offsets(hist_data):
    """SMA20/50/200 as % offset from price (decimal fraction, can be negative)."""
    out = {"SMA20": "-", "SMA50": "-", "SMA200": "-"}
    if not hist_data or len(hist_data) < 2:
        return out
    closes = [d["Close"] for d in hist_data]
    today = closes[-1]
    try:
        for name, n in [("SMA20", 20), ("SMA50", 50), ("SMA200", 200)]:
            if len(closes) >= n:
                sma = sum(closes[-n:]) / n
                if sma != 0:
                    out[name] = fmt_num(today / sma - 1)
    except Exception as ex:
        print('compute_ma_offsets exception: {ex}'.format(ex=ex))
    return out


def compute_hl_offsets(hist_data):
    """52W High / Low as signed decimal offset from current price.
    positive = current price is above that anchor; negative = below."""
    out = {"52W High": "-", "52W Low": "-", "52W Range": "-"}
    if not hist_data or len(hist_data) < 2:
        return out
    closes = [d["Close"] for d in hist_data]
    today = closes[-1]
    try:
        hi = max(closes)
        lo = min(closes)
        if hi != 0:
            out["52W High"] = fmt_num(today / hi - 1)
        if lo != 0:
            out["52W Low"] = fmt_num(today / lo - 1)
        out["52W Range"] = "{lo:.2f} - {hi:.2f}".format(lo=lo, hi=hi)
    except Exception as ex:
        print('compute_hl_offsets exception: {ex}'.format(ex=ex))
    return out


def get_stock_base_info(symbol):
    """Pull fundamentals from yfinance Ticker.info. Returns dict matching the
    original Norn stat.json schema keys, or None on failure."""
    try:
        stock = yf.Ticker(symbol)
        info = stock.info
        if not info or "symbol" not in info:
            return None

        fast = None
        try:
            fast = stock.fast_info
        except Exception:
            fast = None

        close = None
        try:
            if fast is not None:
                close = fast.last_price
        except Exception:
            close = None
        if close is None:
            close = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")

        mc = info.get("marketCap") or (fast.market_cap if fast else None)
        shares = info.get("sharesOutstanding")
        if not shares and fast is not None:
            try:
                shares = fast.shares
            except Exception:
                shares = None

        fcf = info.get("freeCashflow")
        ocf = info.get("operatingCashflow")
        ev = info.get("enterpriseValue")
        fcf_sh = None
        p_fcf = "-"
        if fcf is not None and shares:
            fcf_sh = fcf / shares
        if fcf_sh is not None and close and fcf_sh != 0:
            p_fcf = fmt_num(close / fcf_sh)

        # FCFF / EV: free cash flow yield on enterprise value (decimal).
        # Higher = cheaper on a FCFF basis.
        fcff_ev = "-"
        if fcf is not None and ev:
            fcff_ev = fmt_num(fcf / ev)

        recom = info.get("recommendationMean")
        if recom is None:
            rec_key = info.get("recommendationKey")
            if rec_key == "buy":
                recom = 2.0
            elif rec_key == "hold":
                recom = 3.0
            elif rec_key == "sell":
                recom = 4.0
            elif rec_key == "strong_buy":
                recom = 1.0
            elif rec_key == "strong_sell":
                recom = 5.0

        div_yield = info.get("dividendYield")
        if div_yield is not None:
            div_yield = float(div_yield)

        pe = info.get("trailingPE")
        forward_pe = info.get("forwardPE")

        # dividend %: yfinance dividendYield is a decimal (e.g. 0.0072). Keep as decimal.
        sector_name = info.get("sector")
        industry_name = info.get("industry")
        stat = {
            "sector": SECTOR_INDEX.get(sector_name, "-1"),
            "industry": INDUSTRY_INDEX.get(industry_name, "-1"),
            "P/E": pct_decimal(pe),
            "P/B": pct_decimal(info.get("priceToBook")),
            "Dividend %": pct_decimal(div_yield),
            "Market Cap": mc if mc else "-",
            "ROE": pct_decimal(info.get("returnOnEquity")),
            "ROA": pct_decimal(info.get("returnOnAssets")),
            "ROI": pct_decimal(info.get("returnOnCapitalEmployed") or info.get("returnOnEquity")),
            "P/C": "-",
            "P/S": pct_decimal(info.get("priceToSalesTrailing12Months")),
            "Target Price": fmt_num(info.get("targetMeanPrice")),
            "Short Float": pct_decimal(info.get("shortPercentOfFloat")),
            "Forward P/E": pct_decimal(forward_pe),
            "Insider Trans": "-",
            "PEG": pct_decimal(info.get("pegRatio")),
            "EPS this Y": pct_decimal(info.get("earningsGrowth")),
            "Inst Trans": "-",
            "EPS next Y_%": pct_decimal(info.get("earningsQuarterlyGrowth")),
            "Quick Ratio": pct_decimal(info.get("quickRatio")),
            "Gross Margin": pct_decimal(info.get("grossMargins")),
            "Current Ratio": pct_decimal(info.get("currentRatio")),
            "Oper. Margin": pct_decimal(info.get("operatingMargins")),
            "Debt/Eq": pct_decimal(info.get("debtToEquity")),
            "EPS Q/Q": pct_decimal(info.get("earningsQuarterlyGrowth")),
            "Profit Margin": pct_decimal(info.get("profitMargins")),
            "LT Debt/Eq": "-",
            "Sales Q/Q": pct_decimal(info.get("revenueGrowth")),
            "Recom": fmt_num(recom),
            "P/FCF": p_fcf,
            "FCFF/EV": fcff_ev,
            "beneish": "-",
        }

        # EPS next Y_% - earningsGrowth is "this year" EPS growth in yfinance;
        # use earningsEstimate growth if present. earningsQuarterlyGrowth is Q/Q.
        eps_next_y = info.get("earningsQuarterlyGrowth")
        stat["EPS next Y_%"] = pct_decimal(eps_next_y)

        # EPS next 5Y / past 5Y / Sales past 5Y: not in info; leave "-"
        stat["EPS next 5Y"] = "-"
        stat["EPS past 5Y"] = "-"
        stat["Sales past 5Y"] = "-"

        return stat
    except Exception as ex:
        print('get_stock_base_info exception for {symbol}: {ex}'.format(symbol=symbol, ex=ex))
    return None


def str2timestamp(d):
    return int(datetime.strptime(d, "%m/%d/%Y").timestamp())


def parse_stock_hl_pv(stock_data):
    output = {"PH": 0, "PL": 0, "VH": 0}
    if not stock_data:
        return output
    max_p = stock_data[0]["Close"]
    min_p = stock_data[0]["Close"]
    max_v = stock_data[0]["Volume"]
    for day_data in stock_data[1:]:
        if day_data["Close"] > max_p:
            max_p = day_data["Close"]
            output["PH"] = str2timestamp(day_data["Date"])
        if day_data["Close"] < min_p:
            min_p = day_data["Close"]
            output["PL"] = str2timestamp(day_data["Date"])
        if day_data["Volume"] > max_v:
            max_v = day_data["Volume"]
            output["VH"] = str2timestamp(day_data["Date"])
    return output


def main():
    root = pathlib.Path(__file__).parent.resolve()
    # stat.json is consumed by the front-end from Gatsby's static/ dir
    stock_folder_path = root / ".." / ".." / "static"
    if not os.path.exists(stock_folder_path):
        os.makedirs(stock_folder_path)

    stock_info = get_stock_universe()
    if not stock_info:
        print("empty stock universe, exit")
        sys.exit(1)

    print("scanning {n} symbols".format(n=len(stock_info)))

    load_industry_index()
    print("industry index size: {n}".format(n=len(INDUSTRY_INDEX)))

    stock_stat = {}
    failed = []
    for idx, symbol in enumerate(stock_info):
        stock_data = get_stock_1y_data_from_yahoo(symbol)
        if stock_data and len(stock_data) > 0 and not math.isnan(stock_data[0]["Close"]):
            stat = {
                "Close": stock_data[0]["Close"],
                "P/E": "-", "P/B": "-", "Dividend %": "-", "52W High": "-", "52W Low": "-",
                "Perf Week": "-", "Perf Month": "-", "Perf Quarter": "-", "Perf Half Y": "-",
                "Perf Year": "-", "Perf YTD": "-",
            }
            perf = compute_performance(stock_data)
            ma = compute_ma_offsets(stock_data)
            hl = compute_hl_offsets(stock_data)
            stat.update(perf)
            stat.update(ma)
            stat.update(hl)

            base = get_stock_base_info(symbol)
            if base:
                stat.update(base)

            stock_stat[symbol] = stat
            if (idx + 1) % 50 == 0:
                print('download stock {symbol} ({idx}/{total}) done'.format(symbol=symbol, idx=idx + 1, total=len(stock_info)))
        else:
            failed.append(symbol)
            print('stock {symbol} is null'.format(symbol=symbol))

        time.sleep(DELAY_TIME_SEC)

    with open(stock_folder_path / 'stat.json', 'w', encoding='utf-8') as f:
        f.write(json.dumps(stock_stat, separators=(',', ':')))

    with open(stock_folder_path / 'info.json', 'w', encoding='utf-8') as f:
        f.write(json.dumps(list(stock_stat.keys()), separators=(',', ':')))

    if failed:
        with open(stock_folder_path / 'failed.json', 'w', encoding='utf-8') as f:
            f.write(json.dumps(failed, separators=(',', ':')))

    print('all task done. got {n} stocks, failed {m}'.format(n=len(stock_stat), m=len(failed)))


if __name__ == "__main__":
    main()
