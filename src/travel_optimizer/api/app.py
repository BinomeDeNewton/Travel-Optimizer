"""FastAPI entrypoint for the Travel Optimizer UI."""

from __future__ import annotations

import os
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from travel_optimizer.api.flight_insights import run_flight_insights
from travel_optimizer.api.jobs import Job, JobCancelled, JobQueue
from travel_optimizer.api.schemas import FlightInsightsPayload, PipelinePayload
from travel_optimizer.adapters.io.exports import serialize_pipeline_result
from travel_optimizer.core.config import load_paths
from travel_optimizer.core.models import PipelineRequest, PipelineResult, TimeoffRequest
from travel_optimizer.core.normalization import build_meta, normalize_currency
from travel_optimizer.pipeline.steps import run_destinations, run_flights, run_itinerary, run_lodging, run_timeoff

app = FastAPI(title="Travel Optimizer API")

QUEUE_BACKEND = os.getenv("TRAVEL_OPTIMIZER_QUEUE_BACKEND", "memory").strip().lower()
USE_CELERY = QUEUE_BACKEND == "celery"
if USE_CELERY:
    try:
        from travel_optimizer.api.celery_queue import CeleryJobQueue
    except Exception as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "Celery queue requested but optional dependencies are missing. "
            "Install extras with `uv sync --extra queue`."
        ) from exc
    CELERY_QUEUE = CeleryJobQueue()
else:
    JOB_QUEUE = JobQueue()


def _check_cancelled(job: Job) -> None:
    if job.cancel_event.is_set():
        raise JobCancelled()


def _run_flight_insights_job(job: Job, payload: FlightInsightsPayload) -> Dict[str, object]:
    def progress_cb(label: str, progress: float) -> None:
        JOB_QUEUE.update(job.id, stage=label, progress=progress)
        _check_cancelled(job)

    def cancel_cb() -> None:
        _check_cancelled(job)

    def set_process(process: Optional[object]) -> None:
        JOB_QUEUE.set_process(job.id, process)

    return run_flight_insights(
        payload,
        progress_cb=progress_cb,
        cancel_cb=cancel_cb,
        set_process_cb=set_process,
    )


@app.get("/api/health")
def health() -> Dict[str, object]:
    return {"status": "ok", "meta": build_meta()}


@app.get("/api/artifacts/{artifact_name}")
def get_artifact(artifact_name: str) -> FileResponse:
    safe_name = os.path.basename(artifact_name)
    reports_dir = load_paths().outputs_dir / "reports"
    file_path = reports_dir / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Artifact not found")
    return FileResponse(file_path, filename=safe_name)


@app.post("/api/pipeline")
def run_pipeline(payload: PipelinePayload) -> Dict[str, object]:
    currency = normalize_currency(payload.currency)
    timeoff = TimeoffRequest(
        year=payload.year,
        total_leave_days=payload.leave_days,
        country_code=payload.country_code,
        min_rest_length=payload.min_rest,
    )
    request = PipelineRequest(
        timeoff=timeoff,
        budget=payload.budget,
        currency=currency,
        max_destinations=payload.max_destinations,
        max_flights_per_destination=payload.max_flights_per_destination,
        max_lodging_per_destination=payload.max_lodging_per_destination,
        home_city=payload.home_city,
        preferred_cities=payload.preferred_cities,
        preferred_countries=payload.preferred_countries,
        haul_types=payload.haul_types,
    )

    paths = load_paths()
    try:
        timeoff_result = run_timeoff(request, paths)
        destinations = run_destinations(timeoff_result, request, paths)
        flights = (
            run_flights(destinations, request, paths) if payload.include_flights else []
        )
        lodging = run_lodging(destinations, request, paths)
        itineraries = run_itinerary(timeoff_result, destinations, flights, lodging)
        result = PipelineResult(
            timeoff=timeoff_result,
            destinations=destinations,
            flights=flights,
            lodging=lodging,
            itineraries=itineraries,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    response = serialize_pipeline_result(result)
    response["meta"] = build_meta(currency)
    return response


@app.post("/api/jobs/flight-insights")
def create_flight_insights_job(payload: FlightInsightsPayload) -> Dict[str, object]:
    payload = payload.model_copy(update={"currency": normalize_currency(payload.currency)})
    if USE_CELERY:
        return CELERY_QUEUE.submit_flight_insights(payload)
    job = JOB_QUEUE.submit("flight-insights", _run_flight_insights_job, payload)
    return job.to_dict()


@app.get("/api/jobs")
def list_jobs() -> Dict[str, List[Dict[str, object]]]:
    if USE_CELERY:
        return {"items": CELERY_QUEUE.list_jobs()}
    return {"items": [job.to_dict() for job in JOB_QUEUE.list()]}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> Dict[str, object]:
    if USE_CELERY:
        job = CELERY_QUEUE.get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job
    job = JOB_QUEUE.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict(include_result=True)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> Dict[str, object]:
    if USE_CELERY:
        job = CELERY_QUEUE.cancel_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job
    job = JOB_QUEUE.cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict(include_result=True)


@app.post("/api/flight-insights")
def flight_insights(payload: FlightInsightsPayload) -> Dict[str, object]:
    payload = payload.model_copy(update={"currency": normalize_currency(payload.currency)})
    try:
        return run_flight_insights(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"flight_insights failed: {exc}") from exc
