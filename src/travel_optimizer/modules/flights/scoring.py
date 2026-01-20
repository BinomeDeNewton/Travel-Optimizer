"""Scoring helpers for flight options."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from travel_optimizer.core.models import FlightOption


@dataclass(frozen=True)
class FlightWeights:
    price: float = 0.6
    duration: float = 0.25
    stops: float = 0.15


def score_flight(option: FlightOption, weights: FlightWeights | None = None) -> Optional[float]:
    weights = weights or FlightWeights()
    if option.price is None and option.total_duration_min is None and option.stops is None:
        return None

    score = 0.0
    if option.price is not None:
        score += weights.price * option.price
    if option.total_duration_min is not None:
        score += weights.duration * option.total_duration_min
    if option.stops is not None:
        score += weights.stops * option.stops * 60
    return round(score, 2)
