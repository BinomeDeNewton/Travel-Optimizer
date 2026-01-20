"""Celery tasks for optional Redis-backed job queue."""

from __future__ import annotations

import time
from typing import Dict

from travel_optimizer.api.celery_app import celery_app
from travel_optimizer.api.flight_insights import run_flight_insights
from travel_optimizer.api.schemas import FlightInsightsPayload


@celery_app.task(bind=True, name="travel_optimizer.flight_insights")
def flight_insights_task(self, payload: Dict[str, object]) -> Dict[str, object]:
    def progress_cb(stage: str, progress: float) -> None:
        self.update_state(
            state="PROGRESS",
            meta={"stage": stage, "progress": progress, "updated_at": time.time()},
        )

    return run_flight_insights(FlightInsightsPayload(**payload), progress_cb=progress_cb)
