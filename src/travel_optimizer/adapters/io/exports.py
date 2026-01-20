"""Export helpers for pipeline outputs."""

from __future__ import annotations

from typing import Any, Dict, List

from travel_optimizer.core.models import (
    BaseDayKind,
    DestinationSuggestion,
    FlightOption,
    ItineraryPlan,
    LeaveKind,
    LodgingOption,
    PipelineResult,
    RestPeriod,
    TimeoffResult,
)
from travel_optimizer.modules.timeoff.holidays import holiday_names


def _serialize_rest_period(period: RestPeriod) -> Dict[str, Any]:
    return {
        "start_date": period.start_date.isoformat(),
        "end_date": period.end_date.isoformat(),
        "days": period.days,
    }


def _serialize_timeoff(result: TimeoffResult) -> Dict[str, Any]:
    holiday_name_map = {}
    if result.day_map:
        year = next(iter(result.day_map)).year
        try:
            holiday_name_map = holiday_names(
                year,
                result.country_code or "FR",
                result.subdivision_code,
            )
        except Exception:
            holiday_name_map = {}
    leave_labels = {
        LeaveKind.PAID: "Paid leave",
        LeaveKind.RTT: "RTT",
        LeaveKind.RECUP: "Recuperation",
        LeaveKind.SOFT: "Soft day",
    }
    base_labels = {
        BaseDayKind.WEEKEND: "Weekend",
        BaseDayKind.HOLIDAY: "Holiday",
        BaseDayKind.COMPANY_CLOSURE: "Company closure",
        BaseDayKind.WORKDAY: "Workday",
    }

    def build_reason(info: Any) -> str:
        if info.leave != LeaveKind.NONE:
            label = leave_labels.get(info.leave, info.leave.value)
            reason = f"Optimized leave ({label})"
        else:
            reason = base_labels.get(info.base_kind, info.base_kind.value)
            if info.base_kind == BaseDayKind.HOLIDAY:
                holiday_name = holiday_name_map.get(info.date)
                if holiday_name:
                    reason = f"Holiday: {holiday_name}"
        if info.imposed:
            reason = f"{reason} - imposed"
        return reason

    return {
        "day_map": [
            {
                "date": info.date.isoformat(),
                "base_kind": info.base_kind.value,
                "leave": info.leave.value,
                "locked": info.locked,
                "imposed": info.imposed,
                "holiday_name": holiday_name_map.get(info.date),
                "reason": build_reason(info),
            }
            for _, info in sorted(result.day_map.items())
        ],
        "rest_periods": [_serialize_rest_period(p) for p in result.rest_periods],
        "total_rest_days": result.total_rest_days,
        "used_leave_days": result.used_leave_days,
        "unused_leave_days": result.unused_leave_days,
        "score": result.score,
        "best_month": result.best_month,
        "efficiency_ranking": result.efficiency_ranking,
        "country_code": result.country_code,
        "subdivision_code": result.subdivision_code,
    }


def _serialize_destination(dest: DestinationSuggestion) -> Dict[str, Any]:
    return {
        "rest_period": _serialize_rest_period(dest.rest_period),
        "country": dest.country,
        "country_code": dest.country_code,
        "cities": dest.cities,
        "source_iata": dest.source_iata,
        "destination_iatas": dest.destination_iatas,
        "flight_hours": dest.flight_hours,
        "haul_category": dest.haul_category,
        "climate": dest.climate,
        "safety": dest.safety,
    }


def _serialize_flight(option: FlightOption) -> Dict[str, Any]:
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
    }


def _serialize_lodging(option: LodgingOption) -> Dict[str, Any]:
    return {
        "name": option.name,
        "price_total": option.price_total,
        "rating": option.rating,
        "location": option.location,
        "score": option.score,
    }


def _serialize_itinerary(plan: ItineraryPlan) -> Dict[str, Any]:
    return {
        "rest_period": _serialize_rest_period(plan.rest_period),
        "destination": _serialize_destination(plan.destination) if plan.destination else None,
        "flights": [_serialize_flight(f) for f in plan.flights],
        "lodging": [_serialize_lodging(l) for l in plan.lodging],
        "notes": plan.notes,
    }


def serialize_pipeline_result(result: PipelineResult) -> Dict[str, Any]:
    return {
        "timeoff": _serialize_timeoff(result.timeoff),
        "destinations": [_serialize_destination(d) for d in result.destinations],
        "flights": [_serialize_flight(f) for f in result.flights],
        "lodging": [_serialize_lodging(l) for l in result.lodging],
        "itineraries": [_serialize_itinerary(i) for i in result.itineraries],
    }
