"""Offline tests for the history-metadata quote extraction.

These tests do not touch the network: they drive
get_stock_quote_from_history_metadata() with a fake ticker whose cached chart
metadata is shaped the way yfinance returns it.
"""

import pathlib
import sys
import unittest
from collections.abc import Mapping
from datetime import datetime, timezone

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from fetch_stock_data import get_stock_quote_from_history_metadata


class FakeHistoryMetadata(Mapping):
    """Stand-in for yfinance >= 1.x HistoryMetadata.

    It is a collections.abc.Mapping but deliberately not a dict, which is what
    broke the isinstance(metadata, dict) check.
    """

    def __init__(self, data):
        self._data = data

    def __getitem__(self, key):
        return self._data[key]

    def __iter__(self):
        return iter(self._data)

    def __len__(self):
        return len(self._data)


class FakeTicker:
    """Fake yfinance.Ticker exposing only the cached chart metadata."""

    def __init__(self, metadata):
        self._metadata = metadata

    def get_history_metadata(self):
        return self._metadata


def quote_for(metadata):
    return get_stock_quote_from_history_metadata(FakeTicker(metadata))


class GetStockQuoteFromHistoryMetadataTest(unittest.TestCase):
    def test_accepts_mapping_that_is_not_a_dict(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketPrice": 321.25,
            "regularMarketTime": 1737579600,
            "currency": "USD",
        }))

        self.assertIsNotNone(quote)
        self.assertEqual(quote["Close"], 321.25)
        self.assertEqual(quote["asOf"], "2025-01-22T21:00:00.000Z")
        self.assertEqual(quote["currency"], "USD")

    def test_accepts_legacy_unix_int_time(self):
        for timestamp in (1755300000, 1755300000.0):
            with self.subTest(timestamp=timestamp):
                quote = quote_for({
                    "regularMarketPrice": 12.5,
                    "regularMarketTime": timestamp,
                    "currency": "USD",
                })

                self.assertIsNotNone(quote)
                self.assertEqual(quote["asOf"], "2025-08-15T23:20:00.000Z")

    def test_accepts_pandas_timestamp_time(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketPrice": 199.5,
            "regularMarketTime": pd.Timestamp("2026-08-13 09:31:00", tz="America/New_York"),
            "currency": "USD",
        }))

        self.assertIsNotNone(quote)
        self.assertEqual(quote["asOf"], "2026-08-13T13:31:00.000Z")

    def test_accepts_naive_pandas_timestamp_time_as_utc(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketPrice": 199.5,
            "regularMarketTime": pd.Timestamp("2026-08-13 09:31:00"),
            "currency": "USD",
        }))

        self.assertIsNotNone(quote)
        self.assertEqual(quote["asOf"], "2026-08-13T09:31:00.000Z")

    def test_accepts_aware_datetime_time(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketPrice": 199.5,
            "regularMarketTime": datetime(2026, 8, 13, 13, 31, tzinfo=timezone.utc),
            "currency": "USD",
        }))

        self.assertIsNotNone(quote)
        self.assertEqual(quote["asOf"], "2026-08-13T13:31:00.000Z")

    def test_rejects_non_usd_currency(self):
        for currency in ("EUR", "GBP", ""):
            with self.subTest(currency=currency):
                quote = quote_for(FakeHistoryMetadata({
                    "regularMarketPrice": 666,
                    "regularMarketTime": 1738011600,
                    "currency": currency,
                }))

                self.assertIsNone(quote)

    def test_rejects_missing_price(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketTime": 1737838800,
            "currency": "USD",
        }))

        self.assertIsNone(quote)

    def test_rejects_missing_time(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketPrice": 444,
            "currency": "USD",
        }))

        self.assertIsNone(quote)

    def test_rejects_unusable_time(self):
        quote = quote_for(FakeHistoryMetadata({
            "regularMarketPrice": 444,
            "regularMarketTime": "not-a-time",
            "currency": "USD",
        }))

        self.assertIsNone(quote)

    def test_rejects_missing_metadata(self):
        self.assertIsNone(quote_for(None))
        self.assertIsNone(quote_for({}))


if __name__ == "__main__":
    unittest.main()
