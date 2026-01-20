"""Flight planning with Google Flights (flight_planner.py) or cached summaries."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from travel_optimizer.core.models import DestinationSuggestion, FlightOption
from travel_optimizer.modules.flights.cleaning import load_summary_csv, parse_float, parse_int

LOG = logging.getLogger(__name__)


def _parse_date(value: Optional[str]) -> Optional[datetime.date]:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def _resolve_summary_csv(data_dir: Path) -> Optional[Path]:
    candidates: List[Path] = []
    processed_dir = data_dir / "processed"
    if processed_dir.exists():
        candidates.extend(processed_dir.glob("flights_summary_*_clean.csv"))
    reports_dir = data_dir.parent / "outputs" / "reports"
    if reports_dir.exists():
        candidates.extend(reports_dir.glob("flights_summary_*_clean.csv"))
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def _append_suffix(path: str, suffix: str) -> str:
    base, ext = os.path.splitext(path)
    if not ext:
        ext = ".csv"
    if "_raw_" in base:
        base = base.replace("_raw_", f"_{suffix}_")
    elif base.endswith("_raw"):
        base = base[: -len("_raw")] + f"_{suffix}"
    else:
        base = f"{base}_{suffix}"
    return base + ext


def _resolve_fetch_modes() -> Tuple[str, Optional[str]]:
    raw = os.getenv("TRAVEL_OPTIMIZER_FLIGHT_FETCH_MODE", "local").strip().lower()
    if not raw or raw == "auto":
        return "common", "local"
    if raw == "common":
        return "common", "local"
    if raw == "local":
        return "local", None
    if raw in {"fallback", "force-fallback"}:
        return raw, None
    return raw, None


def _should_patch_local_playwright() -> bool:
    raw = os.getenv("TRAVEL_OPTIMIZER_PATCH_LOCAL_PLAYWRIGHT", "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return False


def _allowed_pairs(destinations: Iterable[DestinationSuggestion]) -> Dict[Tuple[str, str], DestinationSuggestion]:
    mapping: Dict[Tuple[str, str], DestinationSuggestion] = {}
    for suggestion in destinations:
        for origin in suggestion.source_iata:
            for dest in suggestion.destination_iatas:
                mapping[(origin, dest)] = suggestion
    return mapping


def _route_pair_from_row(row: Dict[str, str]) -> Optional[Tuple[str, str]]:
    segment_airports = (row.get("segment_best_airports") or "").strip()
    if segment_airports:
        first_segment = segment_airports.split("|")[0]
        parts = [p.strip() for p in first_segment.split("-") if p.strip()]
        if len(parts) >= 2:
            return parts[0], parts[-1]
    route = (row.get("itinerary_route") or "").strip()
    if "-" in route:
        parts = [p.strip() for p in route.split("-") if p.strip()]
        if len(parts) >= 2:
            return parts[0], parts[-1]
    return None


def _options_from_rows(
    rows: List[Dict[str, str]],
    allowed: Dict[Tuple[str, str], DestinationSuggestion],
    max_per_destination: int,
    provider: str,
) -> List[FlightOption]:
    per_destination_count: Dict[Tuple[str, str], int] = {}
    options: List[FlightOption] = []

    for row in rows:
        pair = _route_pair_from_row(row)
        if not pair or pair not in allowed:
            continue
        current = per_destination_count.get(pair, 0)
        if current >= max_per_destination:
            continue

        depart_date = _parse_date(row.get("trip_start_date"))
        return_date = _parse_date(row.get("trip_end_date"))
        option = FlightOption(
            origin_iata=pair[0],
            destination_iata=pair[1],
            depart_date=depart_date or datetime.now().date(),
            return_date=return_date,
            price=parse_float(row.get("min_total_price")),
            total_duration_min=parse_int(row.get("total_duration_min")),
            stops=parse_int(row.get("total_stops")),
            score=parse_float(row.get("score")),
            provider=provider,
            raw=row,
        )
        options.append(option)
        per_destination_count[pair] = current + 1

    return options


def _write_json(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)


def _build_flight_plan_config(
    suggestion: DestinationSuggestion,
    run_id: str,
    *,
    output_dir: Path,
    cache_dir: Path,
    currency: str,
    max_per_destination: int,
    fetch_mode: str,
) -> Tuple[Path, Path]:
    origin_group = "ORIG"
    dest_group = "DEST"

    stay_nights = max(1, suggestion.rest_period.days - 1)

    config = {
        "groups": {
            origin_group: suggestion.source_iata,
            dest_group: suggestion.destination_iatas,
        },
        "itineraries": [[origin_group, dest_group, origin_group]],
        "departure_dates": {"dates": [suggestion.rest_period.start_date.isoformat()]},
        "return_dates": [suggestion.rest_period.end_date.isoformat()],
        "trip_strategy": "round-trip-when-possible",
        "stay_nights": {dest_group: {"nights": stay_nights}},
        "constraints": {
            "max_itineraries": 1,
            "max_combinations_per_itinerary": 1,
            "max_airports_per_group": 4,
            "max_airport_pairs_per_leg": 8,
            "max_flight_options_per_segment": max_per_destination,
            "max_calls": 0,
        },
        "fetch": {
            "mode": fetch_mode,
            "currency": currency,
            "seat": "economy",
            "max_stops": 1,
            "sleep_seconds": 0.0,
            "patch_local_playwright": fetch_mode == "local" and _should_patch_local_playwright(),
            "local_wait_seconds": 12,
        },
        "passengers": {
            "adults": 1,
            "children": 0,
            "infants_in_seat": 0,
            "infants_on_lap": 0,
        },
        "output": {
            "csv_path": str(output_dir / f"flights_{run_id}.csv"),
            "summary_csv_path": str(output_dir / f"flights_summary_{run_id}.csv"),
            "cache_path": str(cache_dir / "flight_cache.json"),
        },
        "logging": {
            "verbose": False,
            "progress": False,
        },
        "concurrency": {
            "max_workers": 1,
            "rate_limit_per_minute": 20,
        },
        "scoring": {
            "weights": {
                "price": 0.6,
                "duration": 0.2,
                "stops": 0.15,
                "night": 0.05,
            }
        },
    }

    config_path = cache_dir / f"flight_plan_{run_id}.json"
    summary_path = output_dir / f"flights_summary_{run_id}.csv"
    _write_json(config_path, config)
    return config_path, summary_path


def _run_flight_planner(config_path: Path) -> None:
    cmd = [
        sys.executable,
        "-m",
        "travel_optimizer.modules.flights.providers.flight_planner",
        "--config",
        str(config_path),
    ]
    subprocess.run(cmd, check=True)


def _run_google_flights(
    destinations: List[DestinationSuggestion],
    *,
    max_per_destination: int,
    data_dir: Path,
    cache_dir: Path,
) -> List[FlightOption]:
    output_dir = data_dir.parent / "outputs" / "reports"
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    fetch_mode, fallback_mode = _resolve_fetch_modes()

    options: List[FlightOption] = []
    for idx, suggestion in enumerate(destinations, 1):
        if not suggestion.source_iata or not suggestion.destination_iatas:
            continue
        run_id = f"{idx}_{suggestion.rest_period.start_date:%Y%m%d}_{suggestion.rest_period.end_date:%Y%m%d}"
        config_path, summary_path = _build_flight_plan_config(
            suggestion,
            run_id,
            output_dir=output_dir,
            cache_dir=cache_dir,
            currency="EUR",
            max_per_destination=max_per_destination,
            fetch_mode=fetch_mode,
        )
        try:
            _run_flight_planner(config_path)
        except Exception as exc:
            LOG.warning("flight_planner failed for %s: %s", run_id, exc)
            continue

        clean_summary_path = Path(_append_suffix(str(summary_path), "clean"))
        rows = load_summary_csv(str(clean_summary_path))
        if not rows and fallback_mode and fallback_mode != fetch_mode:
            LOG.warning("No results with %s for %s, retrying with %s", fetch_mode, run_id, fallback_mode)
            config_path, summary_path = _build_flight_plan_config(
                suggestion,
                run_id,
                output_dir=output_dir,
                cache_dir=cache_dir,
                currency="EUR",
                max_per_destination=max_per_destination,
                fetch_mode=fallback_mode,
            )
            try:
                _run_flight_planner(config_path)
            except Exception as exc:
                LOG.warning("flight_planner failed for %s (fallback): %s", run_id, exc)
                continue
            clean_summary_path = Path(_append_suffix(str(summary_path), "clean"))
            rows = load_summary_csv(str(clean_summary_path))
        if not rows:
            continue
        allowed = _allowed_pairs([suggestion])
        options.extend(
            _options_from_rows(
                rows,
                allowed,
                max_per_destination=max_per_destination,
                provider="flight_planner",
            )
        )

    return options


def plan_flights(
    destinations: List[DestinationSuggestion],
    *,
    max_per_destination: int,
    data_dir: Path,
    cache_dir: Path,
) -> List[FlightOption]:
    if not destinations:
        return []

    options = _run_google_flights(
        destinations,
        max_per_destination=max_per_destination,
        data_dir=data_dir,
        cache_dir=cache_dir,
    )
    if options:
        return options

    summary_path = _resolve_summary_csv(data_dir)
    if not summary_path:
        return []

    rows = load_summary_csv(str(summary_path))
    if not rows:
        return []

    allowed = _allowed_pairs(destinations)
    return _options_from_rows(
        rows,
        allowed,
        max_per_destination=max_per_destination,
        provider="summary_csv",
    )
