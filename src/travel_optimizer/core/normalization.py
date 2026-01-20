"""Normalization helpers for dates, currencies, and locale/timezone defaults."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, Optional

from zoneinfo import ZoneInfo

DEFAULT_LOCALE = os.getenv("TRAVEL_OPTIMIZER_LOCALE", "fr-FR")
DEFAULT_TIMEZONE = os.getenv("TRAVEL_OPTIMIZER_TIMEZONE", "Europe/Paris")
DEFAULT_CURRENCY = os.getenv("TRAVEL_OPTIMIZER_CURRENCY", "EUR")


@dataclass(frozen=True)
class NormalizationConfig:
    locale: str
    timezone: str
    currency: str


def normalize_currency(value: Optional[str]) -> str:
    if not value:
        return DEFAULT_CURRENCY
    return value.strip().upper()


def normalize_timezone(value: Optional[str]) -> str:
    if not value:
        value = DEFAULT_TIMEZONE
    try:
        ZoneInfo(value)
    except Exception:
        return "UTC"
    return value


def normalize_locale(value: Optional[str]) -> str:
    return value.strip() if value else DEFAULT_LOCALE


def load_normalization(currency: Optional[str] = None) -> NormalizationConfig:
    return NormalizationConfig(
        locale=normalize_locale(DEFAULT_LOCALE),
        timezone=normalize_timezone(DEFAULT_TIMEZONE),
        currency=normalize_currency(currency),
    )


def build_meta(currency: Optional[str] = None) -> Dict[str, str]:
    config = load_normalization(currency)
    return {
        "locale": config.locale,
        "timezone": config.timezone,
        "currency": config.currency,
        "date_format": "YYYY-MM-DD",
        "datetime_format": "YYYY-MM-DDTHH:mm:ssZ",
    }
