"""Shared domain models for the travel optimizer pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Dict, Iterable, List, Optional


class BaseDayKind(Enum):
    WORKDAY = "WORK"
    WEEKEND = "WEEKEND"
    HOLIDAY = "HOLIDAY"
    COMPANY_CLOSURE = "CLOSURE"


class LeaveKind(Enum):
    NONE = "NONE"
    PAID = "CP"
    RTT = "RTT"
    RECUP = "RECUP"
    SOFT = "SOFT"


@dataclass
class DayInfo:
    date: date
    base_kind: BaseDayKind
    leave: LeaveKind = LeaveKind.NONE
    locked: bool = False
    imposed: bool = False


DayMap = Dict[date, DayInfo]


@dataclass(frozen=True)
class RestPeriod:
    start_date: date
    end_date: date

    @property
    def days(self) -> int:
        return (self.end_date - self.start_date).days + 1


@dataclass(frozen=True)
class TimeoffRequest:
    year: int
    total_leave_days: int
    country_code: str = "FR"
    subdivision_code: Optional[str] = None
    min_rest_length: int = 3
    company_closure_dates: Iterable[date] = field(default_factory=list)
    locked_cp_dates: Iterable[date] = field(default_factory=list)
    locked_rtt_dates: Iterable[date] = field(default_factory=list)
    locked_recup_dates: Iterable[date] = field(default_factory=list)
    soft_day_dates: Iterable[date] = field(default_factory=list)


@dataclass
class TimeoffResult:
    day_map: DayMap
    rest_periods: List[RestPeriod]
    total_rest_days: int
    used_leave_days: int
    unused_leave_days: int
    score: float
    best_month: Optional[dict] = None
    efficiency_ranking: List[dict] = field(default_factory=list)
    country_code: str = "FR"
    subdivision_code: Optional[str] = None


@dataclass(frozen=True)
class DestinationSuggestion:
    rest_period: RestPeriod
    country: str
    country_code: Optional[str]
    cities: List[str]
    source_iata: List[str]
    destination_iatas: List[str]
    flight_hours: Optional[float] = None
    haul_category: Optional[str] = None
    climate: Optional[dict] = None
    safety: Optional[dict] = None


@dataclass(frozen=True)
class FlightSearchRequest:
    origin_iata: str
    destination_iata: str
    depart_date: date
    return_date: Optional[date]
    stay_nights: Optional[int] = None


@dataclass
class FlightOption:
    origin_iata: str
    destination_iata: str
    depart_date: date
    return_date: Optional[date]
    price: Optional[float]
    total_duration_min: Optional[int]
    stops: Optional[int]
    score: Optional[float]
    provider: str
    raw: Optional[dict] = None


@dataclass
class LodgingOption:
    name: str
    price_total: Optional[float]
    rating: Optional[float]
    location: Optional[str]
    score: Optional[float]
    raw: Optional[dict] = None


@dataclass
class ItineraryPlan:
    rest_period: RestPeriod
    destination: Optional[DestinationSuggestion]
    flights: List[FlightOption]
    lodging: List[LodgingOption]
    notes: Optional[str] = None


@dataclass(frozen=True)
class PipelineRequest:
    timeoff: TimeoffRequest
    budget: Optional[float] = None
    currency: str = "EUR"
    max_destinations: int = 10
    max_flights_per_destination: int = 5
    max_lodging_per_destination: int = 5
    home_city: Optional[str] = None
    preferred_cities: List[str] = field(default_factory=list)
    preferred_countries: List[str] = field(default_factory=list)
    haul_types: List[str] = field(default_factory=list)


@dataclass
class PipelineResult:
    timeoff: TimeoffResult
    destinations: List[DestinationSuggestion]
    flights: List[FlightOption]
    lodging: List[LodgingOption]
    itineraries: List[ItineraryPlan]
