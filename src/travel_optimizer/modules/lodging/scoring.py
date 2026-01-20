"""Lodging scoring placeholder."""

from __future__ import annotations

from typing import List

from travel_optimizer.core.models import DestinationSuggestion, LodgingOption


def rank_lodging(
    destinations: List[DestinationSuggestion],
    *,
    max_per_destination: int = 5,
) -> List[LodgingOption]:
    return []
