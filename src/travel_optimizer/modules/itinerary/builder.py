"""Itinerary builder for finalized travel plans."""

from __future__ import annotations

from typing import Dict, List, Tuple

from travel_optimizer.core.models import DestinationSuggestion, FlightOption, ItineraryPlan, LodgingOption, RestPeriod, TimeoffResult


def _flight_key(option: FlightOption) -> Tuple[str, str]:
    return option.origin_iata, option.destination_iata


def build_itineraries(
    timeoff_result: TimeoffResult,
    destinations: List[DestinationSuggestion],
    flights: List[FlightOption],
    lodging: List[LodgingOption],
) -> List[ItineraryPlan]:
    flight_map: Dict[Tuple[str, str], List[FlightOption]] = {}
    for option in flights:
        flight_map.setdefault(_flight_key(option), []).append(option)

    itineraries: List[ItineraryPlan] = []
    for period in timeoff_result.rest_periods:
        suggestion = next((s for s in destinations if s.rest_period == period), None)
        selected_flights: List[FlightOption] = []
        if suggestion and suggestion.source_iata and suggestion.destination_iatas:
            key = (suggestion.source_iata[0], suggestion.destination_iatas[0])
            selected_flights = flight_map.get(key, [])
        itineraries.append(
            ItineraryPlan(
                rest_period=period,
                destination=suggestion,
                flights=selected_flights,
                lodging=lodging,
                notes=None,
            )
        )
    return itineraries
