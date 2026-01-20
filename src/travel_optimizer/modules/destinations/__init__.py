"""Destination module."""

from travel_optimizer.modules.destinations.advisor import suggest_destinations
from travel_optimizer.modules.destinations.scoring import score_destination

__all__ = ["suggest_destinations", "score_destination"]
