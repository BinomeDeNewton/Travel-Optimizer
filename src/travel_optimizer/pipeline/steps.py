"""Pipeline step wiring."""

from __future__ import annotations

from typing import List, Tuple

from travel_optimizer.core.config import PathsConfig
from travel_optimizer.core.models import (
    DestinationSuggestion,
    FlightOption,
    ItineraryPlan,
    LodgingOption,
    PipelineRequest,
    TimeoffResult,
)
from travel_optimizer.modules.destinations.advisor import suggest_destinations
from travel_optimizer.modules.flights.planner import plan_flights
from travel_optimizer.modules.itinerary.builder import build_itineraries
from travel_optimizer.modules.lodging.scoring import rank_lodging
from travel_optimizer.modules.timeoff.engine import optimize_timeoff


def run_timeoff(request: PipelineRequest, paths: PathsConfig) -> TimeoffResult:
    return optimize_timeoff(request.timeoff)


def run_destinations(
    timeoff_result: TimeoffResult,
    request: PipelineRequest,
    paths: PathsConfig,
) -> List[DestinationSuggestion]:
    return suggest_destinations(
        country_code=request.timeoff.country_code,
        rest_periods=timeoff_result.rest_periods,
        data_dir=paths.data_dir,
        cache_dir=paths.cache_dir,
        max_destinations=request.max_destinations,
        home_city=request.home_city,
        preferred_cities=request.preferred_cities,
        preferred_countries=request.preferred_countries,
        haul_types=request.haul_types,
    )


def run_flights(
    destinations: List[DestinationSuggestion],
    request: PipelineRequest,
    paths: PathsConfig,
) -> List[FlightOption]:
    return plan_flights(
        destinations,
        max_per_destination=request.max_flights_per_destination,
        data_dir=paths.data_dir,
        cache_dir=paths.cache_dir,
    )


def run_lodging(
    destinations: List[DestinationSuggestion],
    request: PipelineRequest,
    paths: PathsConfig,
) -> List[LodgingOption]:
    return rank_lodging(destinations, max_per_destination=request.max_lodging_per_destination)


def run_itinerary(
    timeoff_result: TimeoffResult,
    destinations: List[DestinationSuggestion],
    flights: List[FlightOption],
    lodging: List[LodgingOption],
) -> List[ItineraryPlan]:
    return build_itineraries(timeoff_result, destinations, flights, lodging)


def run_all(request: PipelineRequest, paths: PathsConfig) -> Tuple[TimeoffResult, List[DestinationSuggestion], List[FlightOption], List[LodgingOption], List[ItineraryPlan]]:
    timeoff_result = run_timeoff(request, paths)
    destinations = run_destinations(timeoff_result, request, paths)
    flights = run_flights(destinations, request, paths)
    lodging = run_lodging(destinations, request, paths)
    itineraries = run_itinerary(timeoff_result, destinations, flights, lodging)
    return timeoff_result, destinations, flights, lodging, itineraries
