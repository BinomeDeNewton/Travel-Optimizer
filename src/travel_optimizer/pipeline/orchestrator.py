"""Pipeline orchestrator for travel optimizer."""

from __future__ import annotations

from typing import List

from travel_optimizer.core.config import PathsConfig, load_paths
from travel_optimizer.core.errors import StepFailedError
from travel_optimizer.core.models import PipelineRequest, PipelineResult
from travel_optimizer.pipeline.results import StepReport
from travel_optimizer.pipeline.steps import run_destinations, run_flights, run_itinerary, run_lodging, run_timeoff


class Orchestrator:
    def __init__(self, paths: PathsConfig | None = None) -> None:
        self.paths = paths or load_paths()
        self.reports: List[StepReport] = []

    def run(self, request: PipelineRequest) -> PipelineResult:
        self.reports.clear()
        try:
            timeoff_result = run_timeoff(request, self.paths)
            self.reports.append(StepReport(name="timeoff", ok=True))
        except Exception as exc:  # pragma: no cover - defensive
            self.reports.append(StepReport(name="timeoff", ok=False, message=str(exc)))
            raise StepFailedError("timeoff step failed") from exc

        try:
            destinations = run_destinations(timeoff_result, request, self.paths)
            self.reports.append(StepReport(name="destinations", ok=True))
        except Exception as exc:
            self.reports.append(StepReport(name="destinations", ok=False, message=str(exc)))
            raise StepFailedError("destinations step failed") from exc

        try:
            flights = run_flights(destinations, request, self.paths)
            self.reports.append(StepReport(name="flights", ok=True))
        except Exception as exc:
            self.reports.append(StepReport(name="flights", ok=False, message=str(exc)))
            raise StepFailedError("flights step failed") from exc

        try:
            lodging = run_lodging(destinations, request, self.paths)
            self.reports.append(StepReport(name="lodging", ok=True))
        except Exception as exc:
            self.reports.append(StepReport(name="lodging", ok=False, message=str(exc)))
            raise StepFailedError("lodging step failed") from exc

        try:
            itineraries = run_itinerary(timeoff_result, destinations, flights, lodging)
            self.reports.append(StepReport(name="itinerary", ok=True))
        except Exception as exc:
            self.reports.append(StepReport(name="itinerary", ok=False, message=str(exc)))
            raise StepFailedError("itinerary step failed") from exc

        return PipelineResult(
            timeoff=timeoff_result,
            destinations=destinations,
            flights=flights,
            lodging=lodging,
            itineraries=itineraries,
        )
