"""Holiday helpers for timeoff optimization."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Dict, Optional, Set, Tuple

try:
    import holidays
except Exception:  # pragma: no cover - optional dependency
    holidays = None

try:
    import pycountry
except Exception:  # pragma: no cover - optional dependency
    pycountry = None

_COUNTRY_ALIASES = {
    "BURMA": "MM",
    "CAPE VERDE": "CV",
    "CONGO (BRAZZAVILLE)": "CG",
    "CONGO (KINSHASA)": "CD",
    "EAST TIMOR": "TL",
    "MACAU": "MO",
    "SWAZILAND": "SZ",
    "TURKEY": "TR",
}


def _resolve_country_code(country_code: str) -> str:
    if not country_code:
        raise ValueError("country_code is required")
    raw = country_code.strip()
    if not raw:
        raise ValueError("country_code is required")
    alias = _COUNTRY_ALIASES.get(raw.upper())
    if alias:
        return alias
    upper = raw.upper()
    if len(upper) == 2 and upper.isalpha():
        return upper
    if pycountry:
        if len(upper) == 3 and upper.isalpha():
            match = pycountry.countries.get(alpha_3=upper)
            if match:
                return match.alpha_2
        match = pycountry.countries.get(name=raw)
        if not match:
            try:
                match = pycountry.countries.search_fuzzy(raw)[0]
            except LookupError:
                match = None
        if match:
            return match.alpha_2
    return upper


def normalize_country_input(
    country_code: str,
    subdiv: Optional[str] = None,
) -> Tuple[str, Optional[str]]:
    if not country_code:
        raise ValueError("country_code is required")
    raw = country_code.strip()
    if not raw:
        raise ValueError("country_code is required")
    normalized_subdiv = subdiv.strip().upper() if subdiv else None
    if not normalized_subdiv:
        for sep in ("-", "_"):
            if sep in raw:
                prefix, suffix = raw.split(sep, 1)
                prefix = prefix.strip()
                suffix = suffix.strip()
                if prefix and suffix:
                    raw = prefix
                    normalized_subdiv = suffix.upper()
                break
    return _resolve_country_code(raw), normalized_subdiv


def calculer_paques(annee: int) -> date:
    a = annee % 19
    b = annee // 100
    c = annee % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mois = (h + l - 7 * m + 114) // 31
    jour = ((h + l - 7 * m + 114) % 31) + 1
    return date(annee, mois, jour)


def french_holiday_names(annee: int) -> Dict[date, str]:
    paques = calculer_paques(annee)
    names = {
        date(annee, 1, 1): "New Year's Day",
        date(annee, 5, 1): "Labor Day",
        date(annee, 5, 8): "Victory in Europe Day",
        date(annee, 7, 14): "Bastille Day",
        date(annee, 8, 15): "Assumption Day",
        date(annee, 11, 1): "All Saints' Day",
        date(annee, 11, 11): "Armistice Day",
        date(annee, 12, 25): "Christmas Day",
        paques: "Easter Sunday",
        paques + timedelta(days=1): "Easter Monday",
        paques + timedelta(days=39): "Ascension Day",
        paques + timedelta(days=50): "Pentecost Monday",
    }
    return names


def french_holidays(annee: int) -> Set[date]:
    return set(french_holiday_names(annee).keys())


def holiday_names(year: int, country_code: str, subdiv: Optional[str] = None) -> Dict[date, str]:
    code, normalized_subdiv = normalize_country_input(country_code, subdiv)
    if holidays is None:
        if code == "FR":
            return french_holiday_names(year)
        raise RuntimeError("holidays package is required for non-FR calendars")
    try:
        holiday_map = holidays.country_holidays(
            code,
            subdiv=normalized_subdiv,
            years=[year],
            observed=True,
        )
    except Exception as exc:
        if code == "FR":
            return french_holiday_names(year)
        raise ValueError(f"Holidays not supported for country {code}") from exc
    names = {day: str(name) for day, name in holiday_map.items() if day.year == year}
    if not names and code == "FR":
        return french_holiday_names(year)
    return names


def holiday_dates(year: int, country_code: str, subdiv: Optional[str] = None) -> Set[date]:
    return set(holiday_names(year, country_code, subdiv).keys())
