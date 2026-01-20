"""Scoring helpers for destinations."""

from __future__ import annotations

from typing import Optional

from travel_optimizer.core.models import DestinationSuggestion


def score_destination(suggestion: DestinationSuggestion) -> Optional[float]:
    if not suggestion.destination_iatas:
        return None
    base = 10.0
    base += min(len(suggestion.cities), 5) * 0.5
    base += min(len(suggestion.destination_iatas), 5) * 0.25
    base += min(suggestion.rest_period.days, 14) * 0.1
    return round(base, 2)
