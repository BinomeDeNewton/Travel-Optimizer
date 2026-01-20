"""Shared flight insights runner for synchronous and async queues."""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional

try:
    import pycountry
except Exception:  # pragma: no cover - optional dependency
    pycountry = None

from travel_optimizer.api.schemas import FlightInsightsPayload
from travel_optimizer.core.normalization import build_meta, normalize_currency
from travel_optimizer.core.config import load_paths
from travel_optimizer.modules.destinations.advisor import DestinationAdvisor
from travel_optimizer.modules.flights.cleaning import load_summary_csv
from travel_optimizer.modules.flights.insights import (
    insights_from_flights,
    insights_from_summary,
    summarize_insights,
)

ProgressCallback = Callable[[str, float], None]
CancelCallback = Callable[[], None]
ProcessCallback = Callable[[Optional[subprocess.Popen]], None]


def _noop_progress(_: str, __: float) -> None:
    return None


def _noop_cancel() -> None:
    return None


def _resolve_country_name(value: str) -> str:
    if not value:
        return value
    if not pycountry:
        return value
    code = value.strip()
    if len(code) == 2:
        match = pycountry.countries.get(alpha_2=code.upper())
    elif len(code) == 3:
        match = pycountry.countries.get(alpha_3=code.upper())
    else:
        match = pycountry.countries.get(name=code)
    if not match:
        try:
            fuzzy = pycountry.countries.search_fuzzy(code)
            if fuzzy:
                match = fuzzy[0]
        except LookupError:
            match = None
    return match.name if match else value


def _unique(values: List[str]) -> List[str]:
    seen = set()
    result: List[str] = []
    for value in values:
        key = value.strip().upper()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(value.strip().upper())
    return result


def _select_airports(
    advisor: DestinationAdvisor,
    *,
    country_name: str,
    city: Optional[str],
    limit: int,
) -> List[str]:
    candidates = [airport for airport in advisor.airports.values() if airport.country == country_name]
    if city:
        city_matches = [airport for airport in candidates if airport.city.lower() == city.lower()]
        if city_matches:
            candidates = city_matches
    candidates.sort(key=lambda airport: advisor.airport_frequencies.get(airport.iata, 0), reverse=True)
    if limit <= 0:
        return [airport.iata for airport in candidates]
    return [airport.iata for airport in candidates[:limit]]


def _append_suffix(path: str, suffix: str) -> str:
    base, ext = Path(path).with_suffix("").as_posix(), Path(path).suffix
    if not ext:
        ext = ".csv"
    if base.endswith("_raw"):
        base = base[: -len("_raw")] + f"_{suffix}"
    else:
        base = f"{base}_{suffix}"
    return base + ext


def _compute_step_days(start: date, end: date, max_points: int) -> int:
    span = (end - start).days
    if span <= 0:
        return 1
    return max(1, int(math.ceil(span / max(1, max_points - 1))))


def _resolve_fetch_modes() -> tuple[str, Optional[str]]:
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


def _build_insights_config(
    *,
    origin_airports: List[str],
    destination_airports: List[str],
    depart_start: date,
    depart_end: date,
    return_start: date,
    return_end: date,
    currency: str,
    fetch_mode: str,
    max_airport_pairs: int,
    max_combinations: int,
    max_flight_options: int,
    max_calls: int,
) -> Dict[str, object]:
    min_nights = max(1, (return_start - depart_end).days)
    max_nights = max(1, (return_end - depart_start).days)
    if min_nights > max_nights:
        min_nights, max_nights = max_nights, min_nights

    step_days = 1
    depart_days = max(1, (depart_end - depart_start).days + 1)
    return_days = max(1, (return_end - return_start).days + 1)
    estimated_pairs = max(1, depart_days * return_days)
    log_every_schedules = max(1, int(math.ceil(estimated_pairs / 200)))
    return {
        "groups": {"ORIG": origin_airports, "DEST": destination_airports},
        "itineraries": [["ORIG", "DEST", "ORIG"]],
        "departure_dates": {
            "start": depart_start.isoformat(),
            "end": depart_end.isoformat(),
            "step_days": step_days,
        },
        "return_dates": {
            "start": return_start.isoformat(),
            "end": return_end.isoformat(),
        },
        "trip_strategy": "chasles-nested",
        "stay_nights": {"DEST": {"min": min_nights, "max": max_nights, "step": 1}},
        "constraints": {
            "max_itineraries": 1,
            "max_combinations_per_itinerary": max_combinations,
            "max_airports_per_group": 0,
            "max_airport_pairs_per_leg": max_airport_pairs,
            "max_flight_options_per_segment": max_flight_options,
            "max_calls": max_calls,
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
        "logging": {
            "verbose": False,
            "progress": False,
            "log_every_schedules": log_every_schedules,
            "log_every_calls": 200,
        },
        "concurrency": {
            "max_workers": "auto",
            "rate_limit_per_minute": 0,
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


def _apply_fetch_mode(config: Dict[str, object], fetch_mode: str) -> None:
    fetch_cfg = config.get("fetch", {})
    if not isinstance(fetch_cfg, dict):
        fetch_cfg = {}
        config["fetch"] = fetch_cfg
    fetch_cfg["mode"] = fetch_mode
    fetch_cfg["patch_local_playwright"] = fetch_mode == "local" and _should_patch_local_playwright()
    if fetch_mode == "local":
        fetch_cfg["local_wait_seconds"] = 12


def _load_insights_rows(
    *,
    summary_path: Path,
    flights_path: Path,
) -> tuple[list[dict], list[dict], Path, Path]:
    clean_summary_path = Path(_append_suffix(str(summary_path), "clean"))
    clean_flights_path = Path(_append_suffix(str(flights_path), "clean"))
    flight_rows = load_summary_csv(str(clean_flights_path if clean_flights_path.exists() else flights_path))
    summary_rows = load_summary_csv(str(clean_summary_path if clean_summary_path.exists() else summary_path))
    return flight_rows, summary_rows, clean_summary_path, clean_flights_path


def run_flight_insights(
    payload: FlightInsightsPayload,
    *,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_cb: Optional[CancelCallback] = None,
    set_process_cb: Optional[ProcessCallback] = None,
) -> Dict[str, object]:
    progress = progress_cb or _noop_progress
    cancel = cancel_cb or _noop_cancel
    currency = normalize_currency(payload.currency)
    schedule_pattern = re.compile(
        r"^\[(it\d+)\]\s+(.+?)\s+\|\s+(\d{4}-\d{2}-\d{2})\s+->\s+(\d{4}-\d{2}-\d{2})\s+\|\s+nights=(\d+)\s+\|\s+stays=(.+)$"
    )
    call_pattern = re.compile(
        r"^Call (\d+): (\S+) (\w+)->(\w+) (\d{4}-\d{2}-\d{2}) (\w+) status=(\w+) flights=(\d+)$"
    )

    def stage(label: str, ratio: float) -> None:
        progress(label, ratio)
        cancel()

    if not payload.destination_countries:
        raise ValueError("destination_countries is required")

    stage("Loading airports", 0.06)
    paths = load_paths()
    advisor = DestinationAdvisor(paths.data_dir)
    advisor.load()

    origin_country = _resolve_country_name(payload.origin_country_code)
    origin_airports = _select_airports(
        advisor,
        country_name=origin_country,
        city=payload.origin_city,
        limit=payload.max_origin_airports,
    )
    if not origin_airports:
        raise ValueError("No origin airports found for the selected city/country.")

    destination_airports: List[str] = []
    for entry in payload.destination_countries:
        country_name = _resolve_country_name(entry)
        destination_airports.extend(
            _select_airports(
                advisor,
                country_name=country_name,
                city=None,
                limit=payload.max_airports_per_country,
            )
        )
    destination_airports = _unique(destination_airports)
    if not destination_airports:
        raise ValueError("No destination airports found for selected countries.")

    run_id = f"{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"
    output_dir = paths.outputs_dir / "reports"
    output_dir.mkdir(parents=True, exist_ok=True)
    paths.cache_dir.mkdir(parents=True, exist_ok=True)

    stage("Preparing search", 0.12)
    fetch_mode, fallback_mode = _resolve_fetch_modes()
    config = _build_insights_config(
        origin_airports=origin_airports,
        destination_airports=destination_airports,
        depart_start=payload.depart_start,
        depart_end=payload.depart_end,
        return_start=payload.return_start,
        return_end=payload.return_end,
        currency=currency,
        fetch_mode=fetch_mode,
        max_airport_pairs=payload.max_airport_pairs,
        max_combinations=payload.max_combinations,
        max_flight_options=payload.max_flight_options,
        max_calls=payload.max_calls,
    )
    summary_path = output_dir / f"flights_summary_insights_{run_id}.csv"
    config_path = paths.cache_dir / f"flight_insights_{run_id}.json"
    flights_path = output_dir / f"flights_insights_{run_id}.csv"
    config["output"] = {
        "csv_path": str(flights_path),
        "summary_csv_path": str(summary_path),
        "cache_path": str(paths.cache_dir / "flight_cache.json"),
    }
    config_path.write_text(json.dumps(config, ensure_ascii=True, indent=2), encoding="utf-8")

    detail_lock = threading.Lock()
    detail_stage: Optional[str] = None

    def set_detail(label: str) -> None:
        nonlocal detail_stage
        with detail_lock:
            detail_stage = label

    def get_detail() -> Optional[str]:
        with detail_lock:
            return detail_stage

    def run_planner(label: str, base_ratio: float, span_ratio: float) -> None:
        nonlocal detail_stage
        stage(label, base_ratio)
        with detail_lock:
            detail_stage = None
        cmd = [
            sys.executable,
            "-m",
            "travel_optimizer.modules.flights.providers.flight_planner",
            "--config",
            str(config_path),
        ]
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if set_process_cb:
            set_process_cb(process)

        def read_stderr() -> None:
            if not process.stderr:
                return
            for raw in iter(process.stderr.readline, ""):
                line = raw.strip()
                if not line:
                    continue
                match = schedule_pattern.match(line)
                if match:
                    itinerary_id, route, start, end, nights, stays = match.groups()
                    pretty_route = route.replace(">", "->")
                    set_detail(
                        f"{itinerary_id} {pretty_route} - {start} -> {end} - {nights} nights - stays {stays}"
                    )
                    continue
                call_match = call_pattern.match(line)
                if call_match:
                    call_id, trip, origin, dest, date_value, mode, status, count = call_match.groups()
                    set_detail(
                        f"Call {call_id} {trip} {origin}->{dest} {date_value} {mode} status={status} flights={count}"
                    )

        reader = threading.Thread(target=read_stderr, daemon=True)
        reader.start()

        start = time.monotonic()
        while True:
            cancel()
            if process.poll() is not None:
                break
            elapsed = time.monotonic() - start
            ratio = base_ratio + min(elapsed / 180.0, 1.0) * span_ratio
            detail = get_detail()
            progress(f"{label} - {detail}" if detail else label, min(ratio, base_ratio + span_ratio))
            time.sleep(0.8)

        if set_process_cb:
            set_process_cb(None)
        if process.returncode not in (0, None):
            raise RuntimeError(f"flight_planner failed (exit code {process.returncode})")

    run_planner(f"Running flight planner ({fetch_mode})", 0.2, 0.65)

    flight_rows, summary_rows, clean_summary_path, clean_flights_path = _load_insights_rows(
        summary_path=summary_path,
        flights_path=flights_path,
    )
    if not flight_rows and not summary_rows and fallback_mode and fallback_mode != fetch_mode:
        stage(f"No results with {fetch_mode}. Retrying with {fallback_mode}.", 0.86)
        _apply_fetch_mode(config, fallback_mode)
        config_path.write_text(json.dumps(config, ensure_ascii=True, indent=2), encoding="utf-8")
        run_planner(f"Running flight planner ({fallback_mode})", 0.86, 0.01)
        flight_rows, summary_rows, clean_summary_path, clean_flights_path = _load_insights_rows(
            summary_path=summary_path,
            flights_path=flights_path,
        )

    stage("Cleaning summaries", 0.88)
    insights = insights_from_flights(
        flight_rows,
        provider="flight_planner",
        depart_start=payload.depart_start,
        depart_end=payload.depart_end,
        return_start=payload.return_start,
        return_end=payload.return_end,
    )
    if not insights:
        insights = insights_from_summary(
            summary_rows,
            provider="flight_planner",
            depart_start=payload.depart_start,
            depart_end=payload.depart_end,
            return_start=payload.return_start,
            return_end=payload.return_end,
        )
    stage("Preparing insights", 0.96)
    summary = {
        "origin_airports": origin_airports,
        "destination_airports": destination_airports,
        "depart_start": payload.depart_start.isoformat(),
        "depart_end": payload.depart_end.isoformat(),
        "return_start": payload.return_start.isoformat(),
        "return_end": payload.return_end.isoformat(),
        "currency": currency,
        "options": len(insights),
    }
    result = summarize_insights(insights, top_n=payload.top_n)
    result["summary"] = summary
    artifacts: Dict[str, Dict[str, str]] = {}

    def add_artifact(path: Path, key: str) -> None:
        if path.exists():
            artifacts[key] = {"name": path.name, "url": f"/api/artifacts/{path.name}"}

    add_artifact(flights_path, "flights_csv")
    add_artifact(clean_flights_path, "flights_clean_csv")
    add_artifact(summary_path, "summary_csv")
    add_artifact(clean_summary_path, "summary_clean_csv")
    report_base = clean_summary_path if clean_summary_path.exists() else summary_path
    report_path = Path(f"{report_base.with_suffix('')}_report.xlsx")
    add_artifact(report_path, "report_excel")
    result["artifacts"] = artifacts
    result["meta"] = build_meta(currency)
    return result
