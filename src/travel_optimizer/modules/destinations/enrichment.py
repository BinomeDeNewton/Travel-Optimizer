"""Keyless destination enrichment (climate + safety)."""

from __future__ import annotations

import json
import math
import time
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

from travel_optimizer.core.models import DestinationSuggestion, RestPeriod

CLIMATE_TTL_SECONDS = 30 * 24 * 3600
SAFETY_TTL_SECONDS = 7 * 24 * 3600

CLIMATE_BASE_URL = "https://archive-api.open-meteo.com/v1/archive"
SAFETY_URL = "https://www.travel-advisory.info/api"


def _load_cache(path: Path) -> Dict[str, dict]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, dict):
            return payload
    except Exception:
        return {}
    return {}


def _save_cache(path: Path, cache: Dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(cache, handle, ensure_ascii=True, indent=2)


def _is_fresh(entry: dict, ttl_seconds: int) -> bool:
    ts = entry.get("ts")
    if not isinstance(ts, (int, float)):
        return False
    return (time.time() - ts) <= ttl_seconds


def _fetch_json(url: str, timeout: int = 12) -> Optional[dict]:
    try:
        req = Request(url, headers={"User-Agent": "travel-optimizer/1.0"})
        with urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except (URLError, ValueError, json.JSONDecodeError):
        return None


def _month_range(period: RestPeriod) -> List[int]:
    months: List[int] = []
    cursor = date(period.start_date.year, period.start_date.month, 1)
    end = date(period.end_date.year, period.end_date.month, 1)
    while cursor <= end:
        months.append(cursor.month)
        next_month = cursor.month + 1
        cursor = date(cursor.year + (1 if next_month == 13 else 0), 1 if next_month == 13 else next_month, 1)
    return months


class ClimateService:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_path = cache_dir / "climate_cache.json"
        self.cache = _load_cache(self.cache_path)
        self.dirty = False
        self.memo: Dict[str, dict] = {}

    def _cache_key(self, lat: float, lon: float) -> str:
        return f"{round(lat, 2)}|{round(lon, 2)}"

    def _fetch_normals(self, lat: float, lon: float) -> Optional[dict]:
        year = date.today().year - 1
        url = (
            f"{CLIMATE_BASE_URL}?latitude={lat:.4f}&longitude={lon:.4f}"
            f"&start_date={year}-01-01&end_date={year}-12-31"
            "&daily=temperature_2m_mean,precipitation_sum&timezone=UTC"
        )
        payload = _fetch_json(url)
        if not payload:
            return None
        daily = payload.get("daily") or {}
        times = daily.get("time") or []
        temps = daily.get("temperature_2m_mean") or []
        precips = daily.get("precipitation_sum") or []
        if not (times and temps and precips):
            return None

        month_temps: Dict[int, List[float]] = {m: [] for m in range(1, 13)}
        month_precip: Dict[int, float] = {m: 0.0 for m in range(1, 13)}
        for idx, stamp in enumerate(times):
            try:
                month = int(stamp[5:7])
            except (ValueError, TypeError):
                continue
            if idx < len(temps) and temps[idx] is not None:
                month_temps[month].append(float(temps[idx]))
            if idx < len(precips) and precips[idx] is not None:
                month_precip[month] += float(precips[idx])

        temp_values = [
            (sum(vals) / len(vals) if vals else None) for _, vals in sorted(month_temps.items())
        ]
        precip_values = [month_precip[m] for m in range(1, 13)]
        return {
            "temp": temp_values,
            "precip": precip_values,
            "source": "open-meteo-archive",
            "source_year": year,
        }

    def _get_normals(self, lat: float, lon: float) -> Optional[dict]:
        key = self._cache_key(lat, lon)
        if key in self.memo:
            return self.memo[key]

        entry = self.cache.get(key)
        if entry and _is_fresh(entry, CLIMATE_TTL_SECONDS):
            data = entry.get("data")
            if isinstance(data, dict):
                self.memo[key] = data
                return data

        data = self._fetch_normals(lat, lon)
        if data:
            self.cache[key] = {"ts": time.time(), "data": data}
            self.dirty = True
            self.memo[key] = data
        return data

    def summarize(self, lat: float, lon: float, months: Iterable[int]) -> Optional[dict]:
        data = self._get_normals(lat, lon)
        if not data:
            return None
        temps = data.get("temp") or []
        precips = data.get("precip") or []
        selected_months = [m for m in months if 1 <= m <= 12]
        if not selected_months:
            return None
        temp_samples = [temps[m - 1] for m in selected_months if m - 1 < len(temps) and temps[m - 1] is not None]
        precip_samples = [precips[m - 1] for m in selected_months if m - 1 < len(precips)]
        if not temp_samples:
            return None
        avg_temp = sum(temp_samples) / len(temp_samples)
        avg_precip = sum(precip_samples) / len(precip_samples) if precip_samples else None
        return {
            "avg_temp_c": round(avg_temp, 1),
            "precip_mm": round(avg_precip, 1) if avg_precip is not None else None,
            "months": selected_months,
            "source": data.get("source"),
            "source_year": data.get("source_year"),
        }

    def flush(self) -> None:
        if self.dirty:
            _save_cache(self.cache_path, self.cache)
            self.dirty = False


class SafetyService:
    def __init__(self, cache_dir: Path) -> None:
        self.cache_path = cache_dir / "safety_cache.json"
        self.cache = _load_cache(self.cache_path)
        self.dirty = False
        self.memo: Dict[str, dict] = {}

    def _score_level(self, score: Optional[float]) -> str:
        if score is None:
            return "Unknown"
        if score < 2:
            return "Low"
        if score < 3:
            return "Moderate"
        if score < 4:
            return "High"
        return "Critical"

    def _get_from_api(self, code: str) -> Optional[dict]:
        payload = _fetch_json(SAFETY_URL)
        if not payload:
            return None
        data = payload.get("data") or {}
        country = data.get(code)
        if not country:
            return None
        advisory = country.get("advisory") or {}
        score = advisory.get("score")
        try:
            score_value = float(score)
            if math.isnan(score_value):
                score_value = None
        except (TypeError, ValueError):
            score_value = None
        summary = {
            "level": self._score_level(score_value),
            "score": score_value,
            "message": advisory.get("message"),
            "updated": advisory.get("updated"),
            "source": "travel-advisory.info",
        }
        return summary

    def get(self, country_code: Optional[str]) -> Optional[dict]:
        if not country_code:
            return None
        code = country_code.upper()
        if code in self.memo:
            return self.memo[code]

        entry = self.cache.get(code)
        if entry and _is_fresh(entry, SAFETY_TTL_SECONDS):
            data = entry.get("data")
            if isinstance(data, dict):
                self.memo[code] = data
                return data

        data = self._get_from_api(code)
        if data:
            self.cache[code] = {"ts": time.time(), "data": data}
            self.dirty = True
            self.memo[code] = data
        return data

    def flush(self) -> None:
        if self.dirty:
            _save_cache(self.cache_path, self.cache)
            self.dirty = False


def enrich_suggestions(
    suggestions: List[DestinationSuggestion],
    *,
    airports: Dict[str, object],
    cache_dir: Path,
) -> List[DestinationSuggestion]:
    climate = ClimateService(cache_dir)
    safety = SafetyService(cache_dir)
    enriched: List[DestinationSuggestion] = []

    for suggestion in suggestions:
        climate_summary = None
        safety_summary = safety.get(suggestion.country_code)

        if suggestion.destination_iatas:
            airport = airports.get(suggestion.destination_iatas[0])
            if airport is not None:
                months = _month_range(suggestion.rest_period)
                try:
                    lat = float(getattr(airport, "lat"))
                    lon = float(getattr(airport, "lon"))
                    climate_summary = climate.summarize(lat, lon, months)
                except (TypeError, ValueError):
                    climate_summary = None

        enriched.append(
            replace(
                suggestion,
                climate=climate_summary,
                safety=safety_summary,
            )
        )

    climate.flush()
    safety.flush()
    return enriched
