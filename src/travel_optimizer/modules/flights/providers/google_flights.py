"""Google Flights provider wrapper (fast_flights)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import List, Optional

from travel_optimizer.core.errors import ProviderError
from travel_optimizer.core.models import FlightOption, FlightSearchRequest
from travel_optimizer.modules.flights.cleaning import parse_duration_minutes


@dataclass(frozen=True)
class GoogleFlightsConfig:
    currency: str = "EUR"
    adults: int = 1
    children: int = 0
    infants_in_seat: int = 0
    infants_on_lap: int = 0
    seat: str = "economy"
    max_stops: Optional[int] = None
    fetch_mode: str = "local"


def _parse_price(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    match = re.search(r"([0-9]+(?:[.,][0-9]+)?)", value)
    if not match:
        return None
    amount = match.group(1).replace(",", ".")
    try:
        return float(amount)
    except ValueError:
        return None


def fetch_flights(request: FlightSearchRequest, config: Optional[GoogleFlightsConfig] = None) -> List[FlightOption]:
    try:
        from fast_flights import FlightData, Passengers, get_flights
    except Exception as exc:  # pragma: no cover - optional dependency
        raise ProviderError("fast_flights is not available") from exc

    config = config or GoogleFlightsConfig()
    passengers = Passengers(
        adults=config.adults,
        children=config.children,
        infants_in_seat=config.infants_in_seat,
        infants_on_lap=config.infants_on_lap,
    )

    fetch_mode = (config.fetch_mode or os.getenv("TRAVEL_OPTIMIZER_FLIGHT_FETCH_MODE", "local")).strip().lower()
    if not fetch_mode:
        fetch_mode = "local"
    trip = "round-trip" if request.return_date else "one-way"
    if request.return_date:
        flight_data = [
            FlightData(
                date=request.depart_date.isoformat(),
                from_airport=request.origin_iata,
                to_airport=request.destination_iata,
            ),
            FlightData(
                date=request.return_date.isoformat(),
                from_airport=request.destination_iata,
                to_airport=request.origin_iata,
            ),
        ]
    else:
        flight_data = [
            FlightData(
                date=request.depart_date.isoformat(),
                from_airport=request.origin_iata,
                to_airport=request.destination_iata,
            )
        ]

    result = get_flights(
        flight_data=flight_data,
        trip=trip,
        seat=config.seat,
        passengers=passengers,
        fetch_mode=fetch_mode,
        max_stops=config.max_stops,
    )

    options: List[FlightOption] = []
    for flight in result.flights:
        if flight is None:
            continue
        options.append(
            FlightOption(
                origin_iata=request.origin_iata,
                destination_iata=request.destination_iata,
                depart_date=request.depart_date,
                return_date=request.return_date,
                price=_parse_price(getattr(flight, "price", None)),
                total_duration_min=parse_duration_minutes(getattr(flight, "duration", None)),
                stops=flight.stops,
                score=None,
                provider="fast_flights",
                raw=flight.to_dict() if hasattr(flight, "to_dict") else None,
            )
        )
    return options
