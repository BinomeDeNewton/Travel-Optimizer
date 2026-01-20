"""Flight insights helpers for summary CSV outputs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, Iterable, List, Optional, Tuple

from travel_optimizer.modules.flights.cleaning import (
    parse_date,
    parse_duration_minutes,
    parse_float,
    parse_int,
)


@dataclass
class FlightInsight:
    origin_iata: str
    destination_iata: str
    depart_date: date
    return_date: Optional[date]
    price: Optional[float]
    total_duration_min: Optional[int]
    stops: Optional[int]
    score: Optional[float]
    provider: str
    flight_name: Optional[str] = None
    departure_time: Optional[str] = None
    arrival_time: Optional[str] = None
    arrival_time_ahead: Optional[str] = None
    duration: Optional[str] = None
    trip_type: Optional[str] = None
    itinerary_route: Optional[str] = None
    segment_route_group: Optional[str] = None
    segment_index: Optional[int] = None
    segment_span: Optional[int] = None
    trip_start_date: Optional[date] = None
    trip_end_date: Optional[date] = None
    trip_nights: Optional[int] = None


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


def _in_range(value: date, start: Optional[date], end: Optional[date]) -> bool:
    if start and value < start:
        return False
    if end and value > end:
        return False
    return True


def insights_from_summary(
    rows: Iterable[Dict[str, str]],
    *,
    provider: str,
    depart_start: Optional[date] = None,
    depart_end: Optional[date] = None,
    return_start: Optional[date] = None,
    return_end: Optional[date] = None,
) -> List[FlightInsight]:
    insights: List[FlightInsight] = []
    for row in rows:
        pair = _route_pair_from_row(row)
        if not pair:
            continue
        depart_date = parse_date(row.get("trip_start_date"))
        if not depart_date:
            continue
        return_date = parse_date(row.get("trip_end_date"))
        if not _in_range(depart_date, depart_start, depart_end):
            continue
        if return_date and not _in_range(return_date, return_start, return_end):
            continue
        insights.append(
            FlightInsight(
                origin_iata=pair[0],
                destination_iata=pair[1],
                depart_date=depart_date,
                return_date=return_date,
                price=parse_float(row.get("min_total_price")),
                total_duration_min=parse_int(row.get("total_duration_min")),
                stops=parse_int(row.get("total_stops")),
                score=parse_float(row.get("score")),
                provider=provider,
                itinerary_route=row.get("itinerary_route"),
                trip_type=row.get("trip_types"),
                trip_start_date=parse_date(row.get("trip_start_date")),
                trip_end_date=parse_date(row.get("trip_end_date")),
                trip_nights=parse_int(row.get("trip_nights")),
            )
        )
    return insights


def insights_from_flights(
    rows: Iterable[Dict[str, str]],
    *,
    provider: str,
    depart_start: Optional[date] = None,
    depart_end: Optional[date] = None,
    return_start: Optional[date] = None,
    return_end: Optional[date] = None,
) -> List[FlightInsight]:
    insights: List[FlightInsight] = []
    for row in rows:
        status = (row.get("status") or "").strip().lower()
        if status and status != "ok":
            continue
        origin = (row.get("from_airport") or "").strip()
        dest = (row.get("to_airport") or "").strip()
        if not origin or not dest:
            continue
        depart_date = parse_date(row.get("segment_date") or row.get("trip_start_date"))
        if not depart_date:
            continue
        return_date = parse_date(row.get("return_date"))
        if not _in_range(depart_date, depart_start, depart_end):
            continue
        if return_date and not _in_range(return_date, return_start, return_end):
            continue
        insights.append(
            FlightInsight(
                origin_iata=origin,
                destination_iata=dest,
                depart_date=depart_date,
                return_date=return_date,
                price=parse_float(row.get("price_value") or row.get("min_total_price")),
                total_duration_min=parse_int(row.get("total_duration_min"))
                or parse_duration_minutes(row.get("duration")),
                stops=parse_int(row.get("stops")),
                score=parse_float(row.get("score")),
                provider=provider,
                flight_name=(row.get("flight_name") or "").strip() or None,
                departure_time=(row.get("departure") or "").strip() or None,
                arrival_time=(row.get("arrival") or "").strip() or None,
                arrival_time_ahead=(row.get("arrival_time_ahead") or "").strip() or None,
                duration=(row.get("duration") or "").strip() or None,
                trip_type=(row.get("trip_type") or "").strip() or None,
                itinerary_route=(row.get("itinerary_route") or "").strip() or None,
                segment_route_group=(row.get("segment_route_group") or "").strip() or None,
                segment_index=parse_int(row.get("segment_index")),
                segment_span=parse_int(row.get("segment_span")),
                trip_start_date=parse_date(row.get("trip_start_date")),
                trip_end_date=parse_date(row.get("trip_end_date")),
                trip_nights=parse_int(row.get("trip_nights")),
            )
        )
    return insights


def _top(
    options: List[FlightInsight],
    *,
    key: str,
    reverse: bool,
    limit: int,
) -> List[FlightInsight]:
    eligible = [opt for opt in options if getattr(opt, key) is not None]
    eligible.sort(key=lambda opt: getattr(opt, key), reverse=reverse)
    return eligible[:limit]


def serialize_insight(option: FlightInsight) -> Dict[str, object]:
    return {
        "origin_iata": option.origin_iata,
        "destination_iata": option.destination_iata,
        "depart_date": option.depart_date.isoformat(),
        "return_date": option.return_date.isoformat() if option.return_date else None,
        "price": option.price,
        "total_duration_min": option.total_duration_min,
        "stops": option.stops,
        "score": option.score,
        "provider": option.provider,
        "flight_name": option.flight_name,
        "departure_time": option.departure_time,
        "arrival_time": option.arrival_time,
        "arrival_time_ahead": option.arrival_time_ahead,
        "duration": option.duration,
        "trip_type": option.trip_type,
        "itinerary_route": option.itinerary_route,
        "segment_route_group": option.segment_route_group,
        "segment_index": option.segment_index,
        "segment_span": option.segment_span,
        "trip_start_date": option.trip_start_date.isoformat() if option.trip_start_date else None,
        "trip_end_date": option.trip_end_date.isoformat() if option.trip_end_date else None,
        "trip_nights": option.trip_nights,
    }


def summarize_insights(options: List[FlightInsight], *, top_n: int) -> Dict[str, List[Dict[str, object]]]:
    eligible = [
        opt
        for opt in options
        if opt.price is not None and opt.total_duration_min is not None and opt.stops is not None
    ]
    if eligible:
        price_values = [opt.price for opt in eligible if opt.price is not None]
        duration_values = [opt.total_duration_min for opt in eligible if opt.total_duration_min is not None]
        stops_values = [opt.stops for opt in eligible if opt.stops is not None]

        def min_max(values: List[float]) -> Tuple[float, float]:
            return min(values), max(values)

        price_min, price_max = min_max(price_values)
        dur_min, dur_max = min_max(duration_values)
        stops_min, stops_max = min_max(stops_values)

        def normalize(value: float, min_value: float, max_value: float) -> float:
            if max_value <= min_value:
                return 0.0
            return (value - min_value) / (max_value - min_value)

        weights = {"price": 0.6, "duration": 0.2, "stops": 0.15}
        weight_sum = sum(weights.values()) or 1.0
        for opt in eligible:
            if opt.score is not None:
                continue
            price_norm = normalize(opt.price, price_min, price_max)
            dur_norm = normalize(opt.total_duration_min, dur_min, dur_max)
            stops_norm = normalize(opt.stops, stops_min, stops_max)
            weighted = (
                weights["price"] * price_norm
                + weights["duration"] * dur_norm
                + weights["stops"] * stops_norm
            )
            score = 1.0 - (weighted / weight_sum)
            opt.score = round(max(0.0, min(1.0, score)) * 100, 2)

    return {
        "top_price": [serialize_insight(o) for o in _top(options, key="price", reverse=False, limit=top_n)],
        "top_duration": [serialize_insight(o) for o in _top(options, key="total_duration_min", reverse=False, limit=top_n)],
        "top_fewest_stops": [serialize_insight(o) for o in _top(options, key="stops", reverse=False, limit=top_n)],
        "top_score": [serialize_insight(o) for o in _top(options, key="score", reverse=True, limit=top_n)],
    }
