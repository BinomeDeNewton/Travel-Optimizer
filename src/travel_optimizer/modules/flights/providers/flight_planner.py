#!/usr/bin/env python3
import argparse
import csv
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import product
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fast_flights import FlightData, Passengers, get_flights


NODE_RE = re.compile(r"^([A-Za-z0-9_]+)(?:\\(([^)]+)\\))?$")


@dataclass(frozen=True)
class NodeSpec:
    group: str
    airports_override: Optional[List[str]] = None


@dataclass(frozen=True)
class ItinerarySpec:
    nodes: List[NodeSpec]
    label: str


@dataclass
class Schedule:
    itinerary: ItinerarySpec
    segment_dates: List[date]
    stay_nights: List[int]


@dataclass(frozen=True)
class TripRequest:
    trip_type: str
    from_node: NodeSpec
    to_node: NodeSpec
    depart_date: date
    return_date: Optional[date]
    stay_nights: Optional[int]
    segment_index: int
    segment_span: int


@dataclass(frozen=True)
class Segment:
    index: int
    from_node: NodeSpec
    to_node: NodeSpec
    depart_date: date
    stay_nights: Optional[int]


@dataclass
class InflightEntry:
    event: threading.Event
    response: Optional[Dict[str, Any]] = None


PROGRESS_TRACKER = None


def set_progress_tracker(tracker: Optional["ProgressTracker"]) -> None:
    global PROGRESS_TRACKER
    PROGRESS_TRACKER = tracker


def log(message: str, enabled: bool) -> None:
    if not enabled:
        return
    if PROGRESS_TRACKER:
        PROGRESS_TRACKER.clear_line()
    print(message, file=sys.stderr, flush=True)
    if PROGRESS_TRACKER:
        PROGRESS_TRACKER.render(force=True)


class ProgressTracker:
    def __init__(
        self,
        *,
        enabled: bool,
        total_schedules: Optional[int],
        total_calls: Optional[int],
        refresh_seconds: float,
    ) -> None:
        self.enabled = enabled
        self.total_schedules = total_schedules
        self.total_calls = total_calls
        self.refresh_seconds = max(refresh_seconds, 0.1)
        self.start_ts = time.time()
        self.last_render = 0.0
        self.last_line_len = 0
        self.schedules_done = 0
        self.calls_done = 0
        self.cache_hits = 0

    def update_schedules(self, delta: int = 1) -> None:
        self.schedules_done += delta
        self.render()

    def update_calls(self, delta: int = 1, cache_hit: Optional[bool] = None) -> None:
        self.calls_done += delta
        if cache_hit is True:
            self.cache_hits += 1
        self.render()

    def clear_line(self) -> None:
        if not self.enabled or self.last_line_len == 0:
            return
        sys.stderr.write("\r" + (" " * self.last_line_len) + "\r")
        sys.stderr.flush()
        self.last_line_len = 0

    def finish(self) -> None:
        if not self.enabled:
            return
        self.clear_line()
        self.enabled = False

    def render(self, force: bool = False) -> None:
        if not self.enabled:
            return
        now = time.time()
        if not force and now - self.last_render < self.refresh_seconds:
            return
        line = self._format_line(now)
        pad = max(0, self.last_line_len - len(line))
        sys.stderr.write("\r" + line + (" " * pad))
        sys.stderr.flush()
        self.last_line_len = len(line)
        self.last_render = now

    def _format_line(self, now: float) -> str:
        elapsed = now - self.start_ts
        schedule_part = self._format_progress(
            label="Schedules",
            current=self.schedules_done,
            total=self.total_schedules,
        )
        calls_part = self._format_progress(
            label="Calls",
            current=self.calls_done,
            total=self.total_calls,
        )
        cache_part = self._format_cache()
        eta_part = self._format_eta(elapsed)
        return f"{schedule_part} | {calls_part} | {cache_part} | {eta_part}"

    def _format_progress(self, label: str, current: int, total: Optional[int]) -> str:
        if total and total > 0:
            ratio = min(current / total, 1.0)
            bar = self._bar(ratio)
            percent = ratio * 100
            return f"{label} {current}/{total} {bar} {percent:5.1f}%"
        return f"{label} {current}/?"

    def _format_cache(self) -> str:
        if self.calls_done <= 0:
            return "Cache hits 0 (0.0%)"
        ratio = (self.cache_hits / self.calls_done) * 100
        return f"Cache hits {self.cache_hits} ({ratio:4.1f}%)"

    def _format_eta(self, elapsed: float) -> str:
        eta_seconds = None
        if self.total_schedules and self.schedules_done:
            remaining = max(self.total_schedules - self.schedules_done, 0)
            eta_seconds = (elapsed / self.schedules_done) * remaining
        elif self.total_calls and self.calls_done:
            remaining = max(self.total_calls - self.calls_done, 0)
            eta_seconds = (elapsed / self.calls_done) * remaining
        if eta_seconds is None:
            return "ETA --:--"
        return f"ETA {self._format_duration(eta_seconds)}"

    @staticmethod
    def _bar(ratio: float, width: int = 14) -> str:
        filled = int(round(ratio * width))
        return "[" + ("#" * filled) + ("-" * (width - filled)) + "]"

    @staticmethod
    def _format_duration(seconds: float) -> str:
        seconds = max(0, int(seconds))
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60
        if hours:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"


class RateLimiter:
    def __init__(self, per_minute: int) -> None:
        if per_minute <= 0:
            raise ValueError("per_minute must be positive")
        self.min_interval = 60.0 / float(per_minute)
        self.lock = threading.Lock()
        self.next_time = time.monotonic()

    def acquire(self) -> None:
        sleep_for = 0.0
        with self.lock:
            now = time.monotonic()
            if now < self.next_time:
                sleep_for = self.next_time - now
                self.next_time += self.min_interval
            else:
                self.next_time = now + self.min_interval
        if sleep_for > 0:
            time.sleep(sleep_for)


def auto_concurrency(fetch_mode: str) -> Tuple[int, int]:
    cores = os.cpu_count() or 2
    if cores <= 2:
        workers = 1
    elif cores <= 4:
        workers = 2
    elif cores <= 8:
        workers = 3
    else:
        workers = 4
    if fetch_mode == "local":
        workers = min(workers, 2)
    rate_per_minute = max(6, workers * 8)
    return workers, rate_per_minute


def resolve_optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    return int(value)


def resolve_auto_int(value: Any, auto_value: int, *, allow_zero: bool = False) -> int:
    if value is None:
        return auto_value
    if isinstance(value, str) and value.lower() == "auto":
        return auto_value
    resolved = int(value)
    if resolved == 0 and not allow_zero:
        return auto_value
    return resolved


def should_log_progress(every: int, index: int) -> bool:
    return every > 0 and index % every == 0


def format_stays(stays: List[int]) -> str:
    if not stays:
        return "-"
    return ",".join(str(value) for value in stays)


def is_airport_code(value: str) -> bool:
    return len(value) == 3 and value.isalpha()


def validate_config(
    *,
    groups: Dict[str, List[str]],
    itineraries: List[ItinerarySpec],
    departure_dates: List[date],
    return_filter: Optional[Dict[str, Any]],
    stay_nights_map: Dict[str, Any],
    verbose: bool,
) -> None:
    warnings: List[str] = []
    for group, airports in groups.items():
        for code in airports:
            if not is_airport_code(code):
                warnings.append(f"Group {group} has invalid airport code: {code}")

    used_groups = {node.group for itinerary in itineraries for node in itinerary.nodes}
    missing_groups = sorted(used_groups - set(groups))
    if missing_groups:
        warnings.append(f"Missing airport groups in config: {', '.join(missing_groups)}")

    stop_groups = {node.group for itinerary in itineraries for node in itinerary.nodes[1:-1]}
    missing_stays = sorted(stop_groups - set(stay_nights_map))
    if missing_stays:
        warnings.append(f"Missing stay_nights for groups: {', '.join(missing_stays)}")

    if not departure_dates:
        warnings.append("No departure dates resolved.")

    if return_filter and return_filter.get("mode") == "set":
        if not return_filter.get("dates"):
            warnings.append("Return dates list is empty.")

    if warnings:
        for warning in warnings:
            log(f"Warning: {warning}", True)
    elif verbose:
        log("Validation: OK (dates and airport codes).", True)
        for group, airports in groups.items():
            shown = airports[:8]
            suffix = "..." if len(airports) > 8 else ""
            log(f"Group {group}: {', '.join(shown)}{suffix}", True)


def build_trip_requests(
    itinerary: ItinerarySpec,
    schedule: Schedule,
    trip_strategy: str,
) -> List[TripRequest]:
    segments: List[Segment] = []
    for seg_idx, depart_date in enumerate(schedule.segment_dates):
        from_node = itinerary.nodes[seg_idx]
        to_node = itinerary.nodes[seg_idx + 1]
        stay_nights = schedule.stay_nights[seg_idx] if seg_idx < len(schedule.stay_nights) else None
        segments.append(
            Segment(
                index=seg_idx,
                from_node=from_node,
                to_node=to_node,
                depart_date=depart_date,
                stay_nights=stay_nights,
            )
        )

    if trip_strategy == "segment":
        return [
            TripRequest(
                trip_type="one-way",
                from_node=seg.from_node,
                to_node=seg.to_node,
                depart_date=seg.depart_date,
                return_date=None,
                stay_nights=seg.stay_nights,
                segment_index=seg.index,
                segment_span=1,
            )
            for seg in segments
        ]

    if trip_strategy == "round-trip-when-possible":
        requests: List[TripRequest] = []
        seg_idx = 0
        total_segments = len(segments)
        while seg_idx < total_segments:
            seg = segments[seg_idx]
            if seg_idx + 1 < total_segments:
                return_node = itinerary.nodes[seg_idx + 2] if seg_idx + 2 < len(itinerary.nodes) else None
                if return_node and return_node == seg.from_node:
                    return_seg = segments[seg_idx + 1]
                    stay_total = (return_seg.depart_date - seg.depart_date).days
                    requests.append(
                        TripRequest(
                            trip_type="round-trip",
                            from_node=seg.from_node,
                            to_node=seg.to_node,
                            depart_date=seg.depart_date,
                            return_date=return_seg.depart_date,
                            stay_nights=stay_total,
                            segment_index=seg.index,
                            segment_span=2,
                        )
                    )
                    seg_idx += 2
                    continue
            requests.append(
                TripRequest(
                    trip_type="one-way",
                    from_node=seg.from_node,
                    to_node=seg.to_node,
                    depart_date=seg.depart_date,
                    return_date=None,
                    stay_nights=seg.stay_nights,
                    segment_index=seg.index,
                    segment_span=1,
                )
            )
            seg_idx += 1
        return requests

    # Chasles/nested: pair reverse segments in a LIFO manner (nested loops).
    stack: List[Segment] = []
    requests = []
    for seg in segments:
        if stack:
            top = stack[-1]
            if top.from_node == seg.to_node and top.to_node == seg.from_node:
                stack.pop()
                stay_total = (seg.depart_date - top.depart_date).days
                requests.append(
                    TripRequest(
                        trip_type="round-trip",
                        from_node=top.from_node,
                        to_node=top.to_node,
                        depart_date=top.depart_date,
                        return_date=seg.depart_date,
                        stay_nights=stay_total,
                        segment_index=top.index,
                        segment_span=seg.index - top.index + 1,
                    )
                )
                continue
        stack.append(seg)

    for seg in stack:
        requests.append(
            TripRequest(
                trip_type="one-way",
                from_node=seg.from_node,
                to_node=seg.to_node,
                depart_date=seg.depart_date,
                return_date=None,
                stay_nights=seg.stay_nights,
                segment_index=seg.index,
                segment_span=1,
            )
        )

    requests.sort(key=lambda req: (req.depart_date, req.segment_index))
    return requests

def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def resolve_date(cfg: Dict[str, Any], key: str, offset_key: str, today: date) -> Optional[date]:
    if key in cfg:
        return parse_date(cfg[key])
    if offset_key in cfg:
        return today + timedelta(days=int(cfg[offset_key]))
    return None


def build_date_list(cfg: Dict[str, Any], today: date) -> List[date]:
    if not cfg:
        return []
    if "dates" in cfg:
        return sorted(parse_date(d) for d in cfg["dates"])
    start = resolve_date(cfg, "start", "start_offset_days", today)
    end = resolve_date(cfg, "end", "end_offset_days", today)
    if start is None or end is None:
        raise ValueError("departure_dates requires start/end or dates")
    if start > end:
        start, end = end, start
    step = int(cfg.get("step_days", 1))
    if step <= 0:
        raise ValueError("step_days must be positive")
    dates: List[date] = []
    current = start
    while current <= end:
        dates.append(current)
        current += timedelta(days=step)
    return dates


def build_date_filter(cfg: Optional[Dict[str, Any]], today: date) -> Optional[Dict[str, Any]]:
    if not cfg:
        return None
    if "dates" in cfg:
        return {"mode": "set", "dates": set(parse_date(d) for d in cfg["dates"])}
    start = resolve_date(cfg, "start", "start_offset_days", today)
    end = resolve_date(cfg, "end", "end_offset_days", today)
    if start is None or end is None:
        raise ValueError("return_date_range requires start/end or dates")
    if start > end:
        start, end = end, start
    return {"mode": "range", "start": start, "end": end}


def build_return_filter(config: Dict[str, Any], today: date) -> Optional[Dict[str, Any]]:
    return_dates_cfg = config.get("return_dates")
    if return_dates_cfg:
        if isinstance(return_dates_cfg, list):
            return build_date_filter({"dates": return_dates_cfg}, today)
        if isinstance(return_dates_cfg, dict):
            return build_date_filter(return_dates_cfg, today)
        raise ValueError("return_dates must be a list or an object with dates/start/end")
    return build_date_filter(config.get("return_date_range"), today)


def date_in_filter(value: date, filt: Optional[Dict[str, Any]]) -> bool:
    if filt is None:
        return True
    if filt["mode"] == "set":
        return value in filt["dates"]
    return filt["start"] <= value <= filt["end"]


def normalize_airports(values: Iterable[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        code = value.strip().upper()
        if not code or code in seen:
            continue
        seen.add(code)
        result.append(code)
    return result


def parse_node_spec(raw: Any) -> NodeSpec:
    if isinstance(raw, str):
        match = NODE_RE.match(raw.strip())
        if not match:
            raise ValueError(f"Invalid node spec: {raw}")
        group = match.group(1).upper()
        airports = match.group(2)
        if airports:
            override = normalize_airports(airports.split(","))
            return NodeSpec(group=group, airports_override=override)
        return NodeSpec(group=group)
    if isinstance(raw, dict):
        group = str(raw.get("group", "")).strip().upper()
        if not group:
            raise ValueError(f"Invalid node spec: {raw}")
        airports = raw.get("airports")
        if airports:
            override = normalize_airports(airports)
            return NodeSpec(group=group, airports_override=override)
        return NodeSpec(group=group)
    raise ValueError(f"Invalid node spec: {raw}")


def format_node(node: NodeSpec) -> str:
    if node.airports_override:
        return f"{node.group}({','.join(node.airports_override)})"
    return node.group


def build_itineraries(raw_itineraries: List[Any]) -> List[ItinerarySpec]:
    itineraries: List[ItinerarySpec] = []
    for raw in raw_itineraries:
        nodes = [parse_node_spec(n) for n in raw]
        label = ">".join(format_node(n) for n in nodes)
        itineraries.append(ItinerarySpec(nodes=nodes, label=label))
    return itineraries


def expand_stay_nights(cfg: Dict[str, Any]) -> List[int]:
    if "nights" in cfg:
        return [int(cfg["nights"])]
    min_n = int(cfg.get("min", 0))
    max_n = int(cfg.get("max", min_n))
    if min_n > max_n:
        min_n, max_n = max_n, min_n
    step = int(cfg.get("step", 1))
    if step <= 0:
        raise ValueError("stay_nights step must be positive")
    return list(range(min_n, max_n + 1, step))


def iter_schedule_combos(
    itinerary: ItinerarySpec,
    departure_dates: List[date],
    stay_nights_map: Dict[str, Any],
    return_filter: Optional[Dict[str, Any]],
    constraints: Dict[str, Any],
) -> Iterable[Schedule]:
    max_combos = int(constraints.get("max_combinations_per_itinerary", 0) or 0)
    trip_range = constraints.get("trip_nights_range") or {}
    trip_min = trip_range.get("min")
    trip_max = trip_range.get("max")

    stop_groups = [node.group for node in itinerary.nodes[1:-1]]
    stay_lists: List[List[int]] = []
    for group in stop_groups:
        stay_cfg = stay_nights_map.get(group)
        if not stay_cfg:
            raise ValueError(f"Missing stay_nights for group {group}")
        stay_lists.append(expand_stay_nights(stay_cfg))

    combo_count = 0
    for start_date in departure_dates:
        combos = product(*stay_lists) if stay_lists else [()]
        for stays in combos:
            segment_dates = [start_date]
            current = start_date
            for nights in stays:
                current = current + timedelta(days=int(nights))
                segment_dates.append(current)
            end_date = segment_dates[-1]
            if not date_in_filter(end_date, return_filter):
                continue
            trip_nights = (end_date - start_date).days
            if trip_min is not None and trip_nights < int(trip_min):
                continue
            if trip_max is not None and trip_nights > int(trip_max):
                continue
            yield Schedule(
                itinerary=itinerary,
                segment_dates=segment_dates,
                stay_nights=[int(x) for x in stays],
            )
            combo_count += 1
            if max_combos and combo_count >= max_combos:
                return


def airports_for_node(
    node: NodeSpec, groups: Dict[str, List[str]], max_per_group: int
) -> List[str]:
    if node.airports_override:
        airports = normalize_airports(node.airports_override)
    else:
        if node.group not in groups:
            raise ValueError(f"Missing group airports for {node.group}")
        airports = normalize_airports(groups[node.group])
    if max_per_group and len(airports) > max_per_group:
        return airports[:max_per_group]
    return airports


def iter_airport_pairs(
    from_airports: List[str], to_airports: List[str], max_pairs: int
) -> Iterable[Tuple[str, str]]:
    count = 0
    for origin in from_airports:
        for dest in to_airports:
            if origin == dest:
                continue
            yield origin, dest
            count += 1
            if max_pairs and count >= max_pairs:
                return


def clean_error(value: Exception) -> str:
    text = " ".join(str(value).split())
    if len(text) > 300:
        return text[:300] + "..."
    return text


def is_no_flights_error(value: Exception) -> bool:
    message = str(value)
    return "No flights found" in message


def parse_price(raw: Optional[str]) -> Tuple[Optional[float], str]:
    if not raw:
        return None, ""
    raw = raw.strip()
    currency = "".join(ch for ch in raw if not ch.isdigit() and ch not in "., ")
    numeric = "".join(ch for ch in raw if ch.isdigit() or ch in ".,")
    numeric = numeric.replace(",", "")
    if not numeric:
        return None, currency
    try:
        return float(numeric), currency
    except ValueError:
        return None, currency


def parse_duration_minutes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    text = value.lower()
    hours = 0
    minutes = 0
    match = re.search(r"(\\d+)\\s*hr", text)
    if match:
        hours = int(match.group(1))
    match = re.search(r"(\\d+)\\s*min", text)
    if match:
        minutes = int(match.group(1))
    if hours == 0 and minutes == 0:
        return None
    return hours * 60 + minutes


def parse_time_minutes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    match = re.search(r"(\\d{1,2}):(\\d{2})\\s*([AP]M)", value)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    meridiem = match.group(3)
    if meridiem == "AM":
        if hour == 12:
            hour = 0
    else:
        if hour != 12:
            hour += 12
    return hour * 60 + minute


def format_output_path(path: Optional[str], run_ts: datetime) -> Optional[str]:
    if not path:
        return None
    tokens = {
        "timestamp": run_ts.strftime("%Y%m%d_%H%M%S"),
        "date": run_ts.strftime("%Y%m%d"),
        "time": run_ts.strftime("%H%M%S"),
    }
    try:
        return path.format(**tokens)
    except (KeyError, ValueError):
        return path


def append_suffix(path: str, suffix: str) -> str:
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


def build_report_path(summary_path: Optional[str]) -> Optional[str]:
    if not summary_path:
        return None
    base, _ = os.path.splitext(summary_path)
    return base + "_report.xlsx"


def is_night_segment(
    departure: Optional[str],
    arrival: Optional[str],
    arrival_time_ahead: Optional[str],
) -> int:
    if arrival_time_ahead:
        return 1
    dep_minutes = parse_time_minutes(departure)
    arr_minutes = parse_time_minutes(arrival)
    if dep_minutes is not None and (dep_minutes >= 22 * 60 or dep_minutes < 6 * 60):
        return 1
    if arr_minutes is not None and arr_minutes < 6 * 60:
        return 1
    return 0


def dedupe_flights(flights: List[Any]) -> List[Any]:
    seen = set()
    result = []
    for flight in flights:
        key = (
            flight.name,
            flight.departure,
            flight.arrival,
            flight.duration,
            flight.price,
            flight.stops,
        )
        if key in seen:
            continue
        seen.add(key)
        result.append(flight)
    return result


def make_cache_key(
    segment_date: date,
    return_date: Optional[date],
    trip_type: str,
    origin: str,
    dest: str,
    seat: str,
    passenger_counts: Dict[str, int],
    max_stops: Optional[int],
    currency: str,
    fetch_mode: str,
) -> str:
    return "|".join(
        [
            segment_date.isoformat(),
            return_date.isoformat() if return_date else "",
            trip_type,
            origin,
            dest,
            seat,
            str(passenger_counts.get("adults", 0)),
            str(passenger_counts.get("children", 0)),
            str(passenger_counts.get("infants_in_seat", 0)),
            str(passenger_counts.get("infants_on_lap", 0)),
            str(max_stops if max_stops is not None else ""),
            currency,
            fetch_mode,
        ]
    )


def load_cache(path: Optional[str]) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        entries = data.get("entries", {})
        return {k: v for k, v in entries.items() if v.get("status") == "ok"}
    except Exception:
        return {}


def save_cache(path: Optional[str], entries: Dict[str, Any]) -> None:
    if not path:
        return
    payload = {"version": 1, "entries": entries}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)


def patch_local_playwright(wait_seconds: float, verbose: bool) -> None:
    try:
        import asyncio
        from playwright.async_api import async_playwright
        import fast_flights.local_playwright as local_pw
    except Exception as exc:
        log(f"Local playwright patch skipped: {exc}", True)
        return

    async def fetch_with_playwright(url: str) -> str:
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page()
            await page.goto(url, wait_until="domcontentloaded")
            if page.url.startswith("https://consent.google.com"):
                consent = page.locator(
                    'button[aria-label="Accept all"], button:has-text("Accept all"), button:has-text("Tout accepter")'
                )
                if await consent.count() > 0:
                    await consent.first.click(force=True)
                    try:
                        await page.wait_for_url(
                            "https://www.google.com/travel/flights?*", timeout=15000
                        )
                    except Exception:
                        pass
            if wait_seconds > 0:
                try:
                    await page.wait_for_function(
                        """
                        () => {
                            const body = document.body;
                            if (!body) return false;
                            const text = body.innerText || "";
                            if (text.includes("No results returned.")) return true;
                            if (text.includes("Oops, something went wrong.")) return true;
                            if (text.includes("Requested flight date is in the past.")) return true;
                            if (document.querySelector('div[jsname="IWWDBc"], div[jsname="YdtKid"]')) return true;
                            if (document.querySelector(".YMlIz.FpEdX")) return true;
                            return false;
                        }
                        """,
                        timeout=int(wait_seconds * 1000),
                    )
                except Exception:
                    pass
            body = await page.evaluate("() => document.body.innerHTML")
            await browser.close()
        return body

    def local_playwright_fetch(params: dict) -> Any:
        url = "https://www.google.com/travel/flights?" + "&".join(
            f"{k}={v}" for k, v in params.items()
        )
        body = asyncio.run(fetch_with_playwright(url))

        class DummyResponse:
            status_code = 200
            text = body
            text_markdown = body

        return DummyResponse

    local_pw.local_playwright_fetch = local_playwright_fetch
    log(f"Local playwright patch applied (wait {wait_seconds:.1f}s).", verbose)


def fetch_segment(
    cache: Dict[str, Any],
    depart_date: date,
    return_date: Optional[date],
    trip_type: str,
    origin: str,
    dest: str,
    seat: str,
    passengers: Passengers,
    passenger_counts: Dict[str, int],
    max_stops: Optional[int],
    currency: str,
    fetch_mode: str,
    max_flights: int,
    cache_lock: Optional[threading.Lock] = None,
    rate_limiter: Optional[RateLimiter] = None,
    inflight: Optional[Dict[str, InflightEntry]] = None,
    inflight_lock: Optional[threading.Lock] = None,
) -> Dict[str, Any]:
    key = make_cache_key(
        segment_date=depart_date,
        return_date=return_date,
        trip_type=trip_type,
        origin=origin,
        dest=dest,
        seat=seat,
        passenger_counts=passenger_counts,
        max_stops=max_stops,
        currency=currency,
        fetch_mode=fetch_mode,
    )
    if cache_lock:
        with cache_lock:
            cached = cache.get(key)
            if cached and cached.get("status") == "ok":
                cached_return = dict(cached)
                cached_return["from_cache"] = True
                return cached_return
            if cached:
                cache.pop(key, None)
    else:
        if key in cache:
            cached = cache[key]
            if cached.get("status") == "ok":
                cached_return = dict(cached)
                cached_return["from_cache"] = True
                return cached_return
            cache.pop(key, None)
    inflight_entry = None
    inflight_owner = False
    if inflight is not None and inflight_lock is not None:
        with inflight_lock:
            inflight_entry = inflight.get(key)
            if inflight_entry is None:
                inflight_entry = InflightEntry(event=threading.Event())
                inflight[key] = inflight_entry
                inflight_owner = True
        if inflight_entry is not None and not inflight_owner:
            inflight_entry.event.wait()
            if inflight_entry.response is not None:
                cached_return = dict(inflight_entry.response)
                cached_return["from_cache"] = True
                cached_return["cache_source"] = "inflight"
                return cached_return
    data: Optional[Dict[str, Any]] = None
    try:
        if rate_limiter:
            rate_limiter.acquire()
        try:
            if trip_type == "round-trip":
                if return_date is None:
                    raise ValueError("round-trip requires return_date")
                flight_data = [
                    FlightData(date=depart_date.isoformat(), from_airport=origin, to_airport=dest),
                    FlightData(date=return_date.isoformat(), from_airport=dest, to_airport=origin),
                ]
                trip = "round-trip"
            else:
                flight_data = [FlightData(date=depart_date.isoformat(), from_airport=origin, to_airport=dest)]
                trip = "one-way"

            result = get_flights(
                flight_data=flight_data,
                trip=trip,
                seat=seat,
                passengers=passengers,
                fetch_mode=fetch_mode,
                max_stops=max_stops,
            )
            flights = dedupe_flights(result.flights)
            data = {
                "status": "ok",
                "current_price": result.current_price,
                "flights": [
                    {
                        "is_best": fl.is_best,
                        "name": fl.name,
                        "departure": fl.departure,
                        "arrival": fl.arrival,
                        "arrival_time_ahead": fl.arrival_time_ahead,
                        "duration": fl.duration,
                        "stops": fl.stops,
                        "delay": fl.delay,
                        "price": fl.price,
                    }
                    for fl in flights
                ],
            }
            if max_flights and len(data["flights"]) > max_flights:
                data["flights"] = data["flights"][:max_flights]
        except Exception as exc:
            status = "error"
            if is_no_flights_error(exc):
                status = "empty"
            data = {"status": status, "error": clean_error(exc), "flights": []}
        if data.get("status") == "ok":
            if cache_lock:
                with cache_lock:
                    cache[key] = data
            else:
                cache[key] = data
        fresh = dict(data)
        fresh["from_cache"] = False
        return fresh
    finally:
        if inflight_entry is not None and inflight_owner:
            if data is None:
                inflight_entry.response = {
                    "status": "error",
                    "error": "inflight failed",
                    "flights": [],
                }
            else:
                inflight_entry.response = dict(data)
            inflight_entry.event.set()
            if inflight_lock:
                with inflight_lock:
                    inflight.pop(key, None)


def write_csv_row(writer: csv.DictWriter, row: Dict[str, Any]) -> None:
    writer.writerow({k: "" if v is None else v for k, v in row.items()})


def run(
    config_path: str,
    dry_run: bool,
    verbose: Optional[bool] = None,
    log_every_calls: Optional[int] = None,
    log_every_schedules: Optional[int] = None,
) -> int:
    with open(config_path, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    logging_cfg = config.get("logging", {})
    cfg_verbose = logging_cfg.get("verbose")
    if verbose is None:
        verbose = bool(cfg_verbose) if cfg_verbose is not None else False
    cfg_log_every_calls = resolve_optional_int(logging_cfg.get("log_every_calls"))
    cfg_log_every_schedules = resolve_optional_int(logging_cfg.get("log_every_schedules"))
    progress_enabled = logging_cfg.get("progress")
    if progress_enabled is None:
        progress_enabled = verbose
    progress_refresh = float(logging_cfg.get("progress_every_seconds", 0.2))
    count_for_progress = bool(logging_cfg.get("count_schedules_for_progress", False))

    concurrency_cfg = config.get("concurrency", {})
    if log_every_calls is None:
        log_every_calls = cfg_log_every_calls
    if log_every_schedules is None:
        log_every_schedules = cfg_log_every_schedules
    if log_every_calls is None and verbose:
        log_every_calls = 10
    if log_every_schedules is None and verbose:
        log_every_schedules = 1
    if log_every_calls is None:
        log_every_calls = 0
    if log_every_schedules is None:
        log_every_schedules = 0

    today = date.today()
    groups = {k.upper(): normalize_airports(v) for k, v in config.get("groups", {}).items()}
    itineraries = build_itineraries(config.get("itineraries", []))
    departure_dates = build_date_list(config.get("departure_dates", {}), today)
    if not departure_dates:
        raise ValueError("No departure dates resolved")
    return_filter = build_return_filter(config, today)

    stay_nights_map = config.get("stay_nights", {})
    constraints = config.get("constraints", {})
    max_itineraries = int(constraints.get("max_itineraries", 0) or 0)
    max_pairs = int(constraints.get("max_airport_pairs_per_leg", 0) or 0)
    max_airports = int(constraints.get("max_airports_per_group", 0) or 0)
    max_flights = int(constraints.get("max_flight_options_per_segment", 0) or 0)
    max_calls = int(constraints.get("max_calls", 0) or 0)

    fetch_cfg = config.get("fetch", {})
    fetch_mode = str(fetch_cfg.get("mode", "local"))
    currency = str(fetch_cfg.get("currency", "")).upper()
    seat = str(fetch_cfg.get("seat", "economy"))
    max_stops = fetch_cfg.get("max_stops")
    sleep_seconds = float(fetch_cfg.get("sleep_seconds", 0))
    if fetch_mode == "local" and fetch_cfg.get("patch_local_playwright", True):
        patch_local_playwright(float(fetch_cfg.get("local_wait_seconds", 8)), verbose)

    trip_strategy = str(config.get("trip_strategy", "segment"))
    if trip_strategy not in {"segment", "round-trip-when-possible", "chasles-nested"}:
        raise ValueError(f"Invalid trip_strategy: {trip_strategy}")

    auto_workers, auto_rate = auto_concurrency(fetch_mode)
    max_workers = resolve_auto_int(concurrency_cfg.get("max_workers"), auto_workers)
    rate_limit_per_minute = resolve_auto_int(
        concurrency_cfg.get("rate_limit_per_minute"), auto_rate, allow_zero=True
    )
    if max_workers < 1:
        max_workers = 1
    if max_workers > 1:
        sleep_seconds = 0.0

    passenger_cfg = config.get("passengers", {})
    passenger_counts = {
        "adults": int(passenger_cfg.get("adults", 1)),
        "children": int(passenger_cfg.get("children", 0)),
        "infants_in_seat": int(passenger_cfg.get("infants_in_seat", 0)),
        "infants_on_lap": int(passenger_cfg.get("infants_on_lap", 0)),
    }
    passengers = Passengers(**passenger_counts)

    output_cfg = config.get("output", {})
    run_ts = datetime.now()
    csv_path = format_output_path(output_cfg.get("csv_path", "flights.csv"), run_ts)
    summary_path = format_output_path(output_cfg.get("summary_csv_path"), run_ts)
    cache_path = output_cfg.get("cache_path")

    total_schedules = max_itineraries if max_itineraries else None
    if total_schedules is None and count_for_progress:
        schedule_count = 0
        for itinerary in itineraries:
            for _ in iter_schedule_combos(
                itinerary=itinerary,
                departure_dates=departure_dates,
                stay_nights_map=stay_nights_map,
                return_filter=return_filter,
                constraints=constraints,
            ):
                schedule_count += 1
        total_schedules = schedule_count

    total_calls = max_calls if max_calls else None
    progress = ProgressTracker(
        enabled=bool(progress_enabled),
        total_schedules=total_schedules,
        total_calls=total_calls,
        refresh_seconds=progress_refresh,
    )
    set_progress_tracker(progress if progress.enabled else None)

    validate_config(
        groups=groups,
        itineraries=itineraries,
        departure_dates=departure_dates,
        return_filter=return_filter,
        stay_nights_map=stay_nights_map,
        verbose=verbose,
    )

    log(f"Config: {config_path}", verbose)
    log(
        "Itineraries: {itins} | Departure dates: {dates} | Max itineraries: {max_it} | Max calls: {max_calls}".format(
            itins=len(itineraries),
            dates=len(departure_dates),
            max_it=max_itineraries or "all",
            max_calls=max_calls or "all",
        ),
        verbose,
    )
    if verbose:
        if return_filter is None:
            log("Return dates: any", True)
        elif return_filter["mode"] == "set":
            log(f"Return dates: {len(return_filter['dates'])} explicit date(s)", True)
        else:
            log(
                "Return dates: {start} -> {end}".format(
                    start=return_filter["start"].isoformat(),
                    end=return_filter["end"].isoformat(),
                ),
                True,
            )
    log(
        "Fetch: mode={mode} seat={seat} currency={currency} max_stops={stops} sleep={sleep}s".format(
            mode=fetch_mode,
            seat=seat,
            currency=currency or "auto",
            stops=max_stops if max_stops is not None else "any",
            sleep=sleep_seconds,
        ),
        verbose,
    )
    log(f"Trip strategy: {trip_strategy}", verbose)
    log(
        "Passengers: adults={adults} children={children} infants_in_seat={infants_in_seat} infants_on_lap={infants_on_lap}".format(
            **passenger_counts
        ),
        verbose,
    )
    log(
        "Logging: verbose={verbose} log_every_calls={calls} log_every_schedules={schedules}".format(
            verbose=verbose,
            calls=log_every_calls or "off",
            schedules=log_every_schedules or "off",
        ),
        verbose,
    )
    log(
        "Progress: enabled={enabled} refresh={refresh}s total_schedules={schedules} total_calls={calls}".format(
            enabled=progress.enabled,
            refresh=progress_refresh,
            schedules=total_schedules if total_schedules is not None else "?",
            calls=total_calls if total_calls is not None else "?",
        ),
        verbose,
    )
    log(
        "Concurrency: workers={workers} rate_limit_per_minute={rate}".format(
            workers=max_workers,
            rate=rate_limit_per_minute if rate_limit_per_minute > 0 else "off",
        ),
        verbose,
    )

    if dry_run:
        log("Dry run: counting schedule combinations.", verbose)
        schedule_count = 0
        for itinerary in itineraries:
            for _ in iter_schedule_combos(
                itinerary=itinerary,
                departure_dates=departure_dates,
                stay_nights_map=stay_nights_map,
                return_filter=return_filter,
                constraints=constraints,
            ):
                schedule_count += 1
                if max_itineraries and schedule_count >= max_itineraries:
                    break
            if max_itineraries and schedule_count >= max_itineraries:
                break
        print(f"Schedules: {schedule_count}")
        log("Dry run complete.", verbose)
        progress.finish()
        set_progress_tracker(None)
        return 0

    cache_entries = load_cache(cache_path)
    log(f"Cache: {cache_path or 'disabled'} entries={len(cache_entries)}", verbose)

    rate_limiter = RateLimiter(rate_limit_per_minute) if rate_limit_per_minute > 0 else None
    executor = ThreadPoolExecutor(max_workers=max_workers) if max_workers > 1 else None
    cache_lock = threading.Lock() if executor else None
    inflight: Dict[str, InflightEntry] = {}
    inflight_lock = threading.Lock() if executor else None

    headers = [
        "itinerary_id",
        "itinerary_route",
        "segment_index",
        "segment_span",
        "query_index",
        "trip_type",
        "segment_route_group",
        "from_group",
        "to_group",
        "from_airport",
        "to_airport",
        "segment_date",
        "return_date",
        "stay_nights",
        "trip_start_date",
        "trip_end_date",
        "trip_nights",
        "flight_is_best",
        "flight_name",
        "departure",
        "arrival",
        "arrival_time_ahead",
        "duration",
        "stops",
        "delay",
        "price_raw",
        "price_value",
        "price_currency",
        "current_price_label",
        "seat",
        "adults",
        "children",
        "infants_in_seat",
        "infants_on_lap",
        "status",
        "error",
    ]

    summary_best: Dict[Tuple[str, int], Dict[str, Any]] = {}
    summary_meta: Dict[str, Dict[str, Any]] = {}

    start_ts = time.time()
    calls = 0
    calls_submitted = 0
    status_counts = {"ok": 0, "empty": 0, "error": 0}
    cache_hits = 0
    cache_misses = 0
    schedule_index = 0
    stop_early = False
    with open(csv_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()

        for itinerary in itineraries:
            for schedule in iter_schedule_combos(
                itinerary=itinerary,
                departure_dates=departure_dates,
                stay_nights_map=stay_nights_map,
                return_filter=return_filter,
                constraints=constraints,
            ):
                if stop_early:
                    break
                schedule_index += 1
                itinerary_id = f"it{schedule_index:04d}"
                trip_start = schedule.segment_dates[0]
                trip_end = schedule.segment_dates[-1]
                trip_nights = (trip_end - trip_start).days
                trip_requests = build_trip_requests(itinerary, schedule, trip_strategy)
                summary_meta[itinerary_id] = {
                    "route": itinerary.label,
                    "trip_start": trip_start,
                    "trip_end": trip_end,
                    "trip_nights": trip_nights,
                    "segments": len(schedule.segment_dates),
                    "queries": len(trip_requests),
                    "trip_types": ",".join(req.trip_type for req in trip_requests),
                }

                if should_log_progress(log_every_schedules, schedule_index):
                    log(
                        "[{idx}] {route} | {start} -> {end} | nights={nights} | stays={stays}".format(
                            idx=itinerary_id,
                            route=itinerary.label,
                            start=trip_start.isoformat(),
                            end=trip_end.isoformat(),
                            nights=trip_nights,
                            stays=format_stays(schedule.stay_nights),
                        ),
                        True,
                    )
                progress.update_schedules(1)

                for query_idx, request in enumerate(trip_requests):
                    if stop_early:
                        break
                    from_node = request.from_node
                    to_node = request.to_node
                    from_airports = airports_for_node(from_node, groups, max_airports)
                    to_airports = airports_for_node(to_node, groups, max_airports)
                    if verbose:
                        detail = "  Query {idx}/{total} {trip} {frm}->{to} {date}".format(
                            idx=query_idx + 1,
                            total=len(trip_requests),
                            trip=request.trip_type,
                            frm=from_node.group,
                            to=to_node.group,
                            date=request.depart_date.isoformat(),
                        )
                        if request.return_date:
                            detail += f" return={request.return_date.isoformat()}"
                        detail += " stay={stay} airports={fa}x{ta}".format(
                            stay=request.stay_nights if request.stay_nights is not None else "-",
                            fa=len(from_airports),
                            ta=len(to_airports),
                        )
                        log(detail, True)

                    pairs = list(iter_airport_pairs(from_airports, to_airports, max_pairs))
                    if max_calls:
                        remaining = max_calls - calls_submitted
                        if remaining <= 0:
                            stop_early = True
                            break
                        if len(pairs) > remaining:
                            pairs = pairs[:remaining]
                    calls_submitted += len(pairs)

                    def handle_response(
                        *,
                        response: Dict[str, Any],
                        origin: str,
                        dest: str,
                    ) -> None:
                        nonlocal calls, cache_hits, cache_misses
                        calls += 1
                        progress.update_calls(1, cache_hit=bool(response.get("from_cache")))
                        if response.get("status") in status_counts:
                            status_counts[response.get("status")] += 1
                        if response.get("from_cache"):
                            cache_hits += 1
                        else:
                            cache_misses += 1

                        if should_log_progress(log_every_calls, calls):
                            log(
                                "    Call {idx}: {trip} {origin}->{dest} {date} {mode} status={status} flights={count}".format(
                                    idx=calls,
                                    trip=request.trip_type,
                                    origin=origin,
                                    dest=dest,
                                    date=request.depart_date.isoformat(),
                                    mode="cache" if response.get("from_cache") else "live",
                                    status=response.get("status"),
                                    count=len(response.get("flights", [])),
                                ),
                                True,
                            )

                        if response["status"] != "ok":
                            if verbose:
                                prefix = "Empty" if response["status"] == "empty" else "Error"
                                detail = response.get("error")
                                log(
                                    "    {prefix}: {origin}->{dest} {date} ({detail})".format(
                                        prefix=prefix,
                                        origin=origin,
                                        dest=dest,
                                        date=request.depart_date.isoformat(),
                                        detail=detail or "no details",
                                    ),
                                    True,
                                )
                            write_csv_row(
                                writer,
                                {
                                    "itinerary_id": itinerary_id,
                                    "itinerary_route": itinerary.label,
                                    "segment_index": request.segment_index,
                                    "segment_span": request.segment_span,
                                    "query_index": query_idx,
                                    "trip_type": request.trip_type,
                                    "segment_route_group": f"{from_node.group}>{to_node.group}",
                                    "from_group": from_node.group,
                                    "to_group": to_node.group,
                                    "from_airport": origin,
                                    "to_airport": dest,
                                    "segment_date": request.depart_date.isoformat(),
                                    "return_date": request.return_date.isoformat() if request.return_date else None,
                                    "stay_nights": request.stay_nights,
                                    "trip_start_date": trip_start.isoformat(),
                                    "trip_end_date": trip_end.isoformat(),
                                    "trip_nights": trip_nights,
                                    "seat": seat,
                                    "adults": passenger_counts["adults"],
                                    "children": passenger_counts["children"],
                                    "infants_in_seat": passenger_counts["infants_in_seat"],
                                    "infants_on_lap": passenger_counts["infants_on_lap"],
                                    "status": response["status"],
                                    "error": response.get("error"),
                                },
                            )
                            return

                        for flight in response["flights"]:
                            price_value, price_currency = parse_price(flight.get("price"))
                            if price_value is not None:
                                key = (itinerary_id, query_idx)
                                current_best = summary_best.get(key)
                                if current_best is None or price_value < current_best["price_value"]:
                                    duration_min = parse_duration_minutes(flight.get("duration"))
                                    stops = flight.get("stops")
                                    stops_value = stops if isinstance(stops, int) else None
                                    night_flag = is_night_segment(
                                        flight.get("departure"),
                                        flight.get("arrival"),
                                        flight.get("arrival_time_ahead"),
                                    )
                                    summary_best[key] = {
                                        "price_value": price_value,
                                        "duration_min": duration_min,
                                        "stops": stops_value,
                                        "night": night_flag,
                                        "from_airport": origin,
                                        "to_airport": dest,
                                        "airline": flight.get("name"),
                                    }

                            write_csv_row(
                                writer,
                                {
                                    "itinerary_id": itinerary_id,
                                    "itinerary_route": itinerary.label,
                                    "segment_index": request.segment_index,
                                    "segment_span": request.segment_span,
                                    "query_index": query_idx,
                                    "trip_type": request.trip_type,
                                    "segment_route_group": f"{from_node.group}>{to_node.group}",
                                    "from_group": from_node.group,
                                    "to_group": to_node.group,
                                    "from_airport": origin,
                                    "to_airport": dest,
                                    "segment_date": request.depart_date.isoformat(),
                                    "return_date": request.return_date.isoformat() if request.return_date else None,
                                    "stay_nights": request.stay_nights,
                                    "trip_start_date": trip_start.isoformat(),
                                    "trip_end_date": trip_end.isoformat(),
                                    "trip_nights": trip_nights,
                                    "flight_is_best": flight.get("is_best"),
                                    "flight_name": flight.get("name"),
                                    "departure": flight.get("departure"),
                                    "arrival": flight.get("arrival"),
                                    "arrival_time_ahead": flight.get("arrival_time_ahead"),
                                    "duration": flight.get("duration"),
                                    "stops": flight.get("stops"),
                                    "delay": flight.get("delay"),
                                    "price_raw": flight.get("price"),
                                    "price_value": price_value,
                                    "price_currency": price_currency or currency,
                                    "current_price_label": response.get("current_price"),
                                    "seat": seat,
                                    "adults": passenger_counts["adults"],
                                    "children": passenger_counts["children"],
                                    "infants_in_seat": passenger_counts["infants_in_seat"],
                                    "infants_on_lap": passenger_counts["infants_on_lap"],
                                    "status": response["status"],
                                },
                            )

                    def fetch_task(origin: str, dest: str) -> Tuple[str, str, Dict[str, Any]]:
                        response = fetch_segment(
                            cache=cache_entries,
                            depart_date=request.depart_date,
                            return_date=request.return_date,
                            trip_type=request.trip_type,
                            origin=origin,
                            dest=dest,
                            seat=seat,
                            passengers=passengers,
                            passenger_counts=passenger_counts,
                            max_stops=max_stops,
                            currency=currency,
                            fetch_mode=fetch_mode,
                            max_flights=max_flights,
                            cache_lock=cache_lock,
                            rate_limiter=rate_limiter,
                            inflight=inflight if inflight_lock else None,
                            inflight_lock=inflight_lock,
                        )
                        return origin, dest, response

                    if executor:
                        futures = [executor.submit(fetch_task, origin, dest) for origin, dest in pairs]
                        for future in as_completed(futures):
                            origin, dest, response = future.result()
                            handle_response(response=response, origin=origin, dest=dest)
                    else:
                        for origin, dest in pairs:
                            response = fetch_task(origin, dest)[2]
                            handle_response(response=response, origin=origin, dest=dest)
                            if sleep_seconds > 0:
                                time.sleep(sleep_seconds)

                if max_itineraries and schedule_index >= max_itineraries:
                    break
            if max_itineraries and schedule_index >= max_itineraries:
                break
            if stop_early:
                break

    if executor:
        executor.shutdown(wait=True)
    if stop_early:
        log("Reached max_calls limit, stopping.", True)

    if summary_path:
        summary_headers = [
            "itinerary_id",
            "itinerary_route",
            "trip_start_date",
            "trip_end_date",
            "trip_nights",
            "segments",
            "query_count",
            "trip_types",
            "priced_segments",
            "min_total_price",
            "total_duration_min",
            "total_stops",
            "night_segments",
            "score",
            "price_currency",
            "segment_min_prices",
            "segment_best_airports",
            "segment_best_airlines",
        ]

        scoring_cfg = config.get("scoring", {})
        weights_cfg = scoring_cfg.get("weights", {})
        weights = {
            "price": float(weights_cfg.get("price", 0.6)),
            "duration": float(weights_cfg.get("duration", 0.2)),
            "stops": float(weights_cfg.get("stops", 0.15)),
            "night": float(weights_cfg.get("night", 0.05)),
        }
        weight_sum = sum(weights.values())
        if weight_sum <= 0:
            weights = {"price": 1.0, "duration": 0.0, "stops": 0.0, "night": 0.0}
            weight_sum = 1.0
        for key in weights:
            weights[key] = weights[key] / weight_sum

        summary_rows = []
        for itinerary_id, meta in summary_meta.items():
            segment_prices = []
            segment_airports = []
            segment_airlines = []
            priced_segments = 0
            total_price = 0.0
            total_duration = 0
            total_stops = 0
            night_segments = 0
            duration_ok = True
            stops_ok = True

            for query_idx in range(meta["queries"]):
                entry = summary_best.get((itinerary_id, query_idx))
                if not entry:
                    segment_prices.append("")
                    segment_airports.append("")
                    segment_airlines.append("")
                    continue
                segment_prices.append(str(entry["price_value"]))
                from_airport = entry.get("from_airport")
                to_airport = entry.get("to_airport")
                if from_airport and to_airport:
                    segment_airports.append(f"{from_airport}-{to_airport}")
                else:
                    segment_airports.append("")
                segment_airlines.append(entry.get("airline") or "")
                priced_segments += 1
                total_price += entry["price_value"]
                if entry["duration_min"] is None:
                    duration_ok = False
                else:
                    total_duration += entry["duration_min"]
                if entry["stops"] is None:
                    stops_ok = False
                else:
                    total_stops += entry["stops"]
                night_segments += int(entry.get("night", 0))

            row = {
                "itinerary_id": itinerary_id,
                "itinerary_route": meta["route"],
                "trip_start_date": meta["trip_start"].isoformat(),
                "trip_end_date": meta["trip_end"].isoformat(),
                "trip_nights": meta["trip_nights"],
                "segments": meta["segments"],
                "query_count": meta["queries"],
                "trip_types": meta["trip_types"],
                "priced_segments": priced_segments,
                "min_total_price": total_price if priced_segments == meta["queries"] else None,
                "total_duration_min": total_duration if duration_ok and priced_segments == meta["queries"] else None,
                "total_stops": total_stops if stops_ok and priced_segments == meta["queries"] else None,
                "night_segments": night_segments if priced_segments == meta["queries"] else None,
                "score": None,
                "price_currency": currency,
                "segment_min_prices": "|".join(segment_prices),
                "segment_best_airports": "|".join(segment_airports),
                "segment_best_airlines": "|".join(segment_airlines),
            }
            summary_rows.append(row)

        def valid_metric(row: Dict[str, Any], key: str) -> bool:
            return row[key] is not None

        eligible = [
            row
            for row in summary_rows
            if valid_metric(row, "min_total_price")
            and valid_metric(row, "total_duration_min")
            and valid_metric(row, "total_stops")
            and valid_metric(row, "night_segments")
        ]
        if eligible:
            price_values = [row["min_total_price"] for row in eligible]
            duration_values = [row["total_duration_min"] for row in eligible]
            stops_values = [row["total_stops"] for row in eligible]
            night_values = [row["night_segments"] for row in eligible]

            def min_max(values: List[float]) -> Tuple[float, float]:
                return min(values), max(values)

            price_min, price_max = min_max(price_values)
            dur_min, dur_max = min_max(duration_values)
            stops_min, stops_max = min_max(stops_values)
            night_min, night_max = min_max(night_values)

            def normalize(value: float, min_value: float, max_value: float) -> float:
                if max_value <= min_value:
                    return 0.0
                return (value - min_value) / (max_value - min_value)

            for row in eligible:
                price_norm = normalize(row["min_total_price"], price_min, price_max)
                dur_norm = normalize(row["total_duration_min"], dur_min, dur_max)
                stops_norm = normalize(row["total_stops"], stops_min, stops_max)
                night_norm = normalize(row["night_segments"], night_min, night_max)
                score = 1.0 - (
                    weights["price"] * price_norm
                    + weights["duration"] * dur_norm
                    + weights["stops"] * stops_norm
                    + weights["night"] * night_norm
                )
                row["score"] = round(max(0.0, min(1.0, score)) * 100, 2)

        def score_key(row: Dict[str, Any]) -> Tuple[int, float]:
            score = row.get("score")
            if score is None:
                return (1, 0.0)
            return (0, float(score))

        summary_rows.sort(key=score_key, reverse=True)

        with open(summary_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=summary_headers)
            writer.writeheader()
            for row in summary_rows:
                write_csv_row(writer, row)

    progress.finish()
    set_progress_tracker(None)
    elapsed = time.time() - start_ts
    log(
        "Done. Calls={calls} cache_hits={hits} cache_misses={misses} elapsed={elapsed:.1f}s".format(
            calls=calls,
            hits=cache_hits,
            misses=cache_misses,
            elapsed=elapsed,
        ),
        verbose,
    )
    log(
        "Statuses: ok={ok} empty={empty} error={error}".format(**status_counts),
        verbose,
    )
    log(
        "Output: {csv}{summary}".format(
            csv=csv_path,
            summary=f", {summary_path}" if summary_path else "",
        ),
        verbose,
    )

    save_cache(cache_path, cache_entries)
    if csv_path:
        try:
            from travel_optimizer.modules.flights.cleaning import clean_flights as clean_flights_func

            clean_csv_path = append_suffix(csv_path, "clean")
            clean_summary_path = append_suffix(summary_path, "clean") if summary_path else None
            rejected_path = append_suffix(csv_path, "rejected")
            report_path = build_report_path(clean_summary_path) if clean_summary_path else None
            clean_flights_func(
                input_path=csv_path,
                output_path=clean_csv_path,
                summary_path=clean_summary_path,
                rejected_path=rejected_path,
                config_path=config_path,
                report_path=report_path,
            )
            if report_path and not os.path.exists(report_path):
                log(f"Post-clean report missing: {report_path}", True)
                return 1
        except Exception as exc:
            log(f"Post-clean failed: {exc}", True)
            return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan multi-segment trips with fast_flights.")
    parser.add_argument("--config", default="flight_plan_Octobre2026.json", help="Path to JSON config.")
    parser.add_argument("--dry-run", action="store_true", help="Only count schedules.")
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=None,
        help="Enable verbose progress logging.",
    )
    parser.add_argument(
        "--log-every-calls",
        type=int,
        default=None,
        help="Log every N calls (0 disables).",
    )
    parser.add_argument(
        "--log-every-schedules",
        type=int,
        default=None,
        help="Log every N schedules (0 disables).",
    )
    args = parser.parse_args()
    return run(
        args.config,
        args.dry_run,
        verbose=args.verbose,
        log_every_calls=args.log_every_calls,
        log_every_schedules=args.log_every_schedules,
    )


if __name__ == "__main__":
    raise SystemExit(main())
