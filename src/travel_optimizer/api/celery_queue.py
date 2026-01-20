"""Redis-backed job registry with Celery integration."""

from __future__ import annotations

import json
import os
import time
from typing import Dict, List, Optional

from celery.result import AsyncResult
from redis import Redis

from travel_optimizer.api.celery_app import celery_app
from travel_optimizer.api.celery_tasks import flight_insights_task
from travel_optimizer.api.schemas import FlightInsightsPayload


def _env(name: str, default: str) -> str:
    return os.getenv(name, default)


class CeleryJobQueue:
    def __init__(self) -> None:
        redis_url = _env("TRAVEL_OPTIMIZER_REDIS_URL", _env("CELERY_BROKER_URL", "redis://localhost:6379/0"))
        self._redis = Redis.from_url(redis_url, decode_responses=True)
        self._jobs_key = _env("TRAVEL_OPTIMIZER_JOBS_KEY", "travel_optimizer:jobs")
        self._max_jobs = int(_env("TRAVEL_OPTIMIZER_MAX_JOBS", "100"))

    def submit_flight_insights(self, payload: FlightInsightsPayload) -> Dict[str, object]:
        task = flight_insights_task.delay(payload.model_dump(mode="json"))
        self._register_job(task.id, "flight-insights")
        return self._format_job(task.id, "flight-insights", created_at=time.time())

    def list_jobs(self) -> List[Dict[str, object]]:
        entries = self._redis.lrange(self._jobs_key, 0, self._max_jobs - 1)
        seen = set()
        jobs: List[Dict[str, object]] = []
        for raw in entries:
            try:
                meta = json.loads(raw)
            except json.JSONDecodeError:
                continue
            job_id = meta.get("id")
            if not job_id or job_id in seen:
                continue
            seen.add(job_id)
            jobs.append(self._format_job(job_id, meta.get("kind", "flight-insights"), meta.get("created_at")))
        return jobs

    def get_job(self, job_id: str) -> Optional[Dict[str, object]]:
        meta = self._find_job_meta(job_id)
        if not meta:
            return None
        return self._format_job(job_id, meta.get("kind", "flight-insights"), meta.get("created_at"), include_result=True)

    def cancel_job(self, job_id: str) -> Optional[Dict[str, object]]:
        meta = self._find_job_meta(job_id)
        if not meta:
            return None
        AsyncResult(job_id, app=celery_app).revoke(terminate=True, signal="SIGTERM")
        return self._format_job(job_id, meta.get("kind", "flight-insights"), meta.get("created_at"), include_result=True)

    def _register_job(self, job_id: str, kind: str) -> None:
        payload = json.dumps({"id": job_id, "kind": kind, "created_at": time.time()}, ensure_ascii=True)
        self._redis.lpush(self._jobs_key, payload)
        self._redis.ltrim(self._jobs_key, 0, self._max_jobs - 1)

    def _find_job_meta(self, job_id: str) -> Optional[Dict[str, object]]:
        entries = self._redis.lrange(self._jobs_key, 0, self._max_jobs - 1)
        for raw in entries:
            try:
                meta = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if meta.get("id") == job_id:
                return meta
        return None

    def _format_job(
        self,
        job_id: str,
        kind: str,
        created_at: Optional[float],
        *,
        include_result: bool = False,
    ) -> Dict[str, object]:
        result = AsyncResult(job_id, app=celery_app)
        state = result.state
        info = result.info if isinstance(result.info, dict) else {}
        status = self._map_state(state)
        progress = float(info.get("progress", 0.0)) if isinstance(info, dict) else 0.0
        if status == "completed":
            progress = 1.0
        stage = info.get("stage") if isinstance(info, dict) else None
        if not stage:
            stage = "Cancelled" if status == "cancelled" else state.title()
        updated_at = info.get("updated_at") if isinstance(info, dict) else None
        if not updated_at:
            updated_at = result.date_done.timestamp() if getattr(result, "date_done", None) else time.time()
        error = str(result.info) if status == "failed" else None

        payload: Dict[str, object] = {
            "id": job_id,
            "kind": kind,
            "status": status,
            "progress": round(max(0.0, min(progress, 1.0)), 3),
            "stage": stage,
            "created_at": created_at or time.time(),
            "updated_at": updated_at,
            "error": error,
        }
        if include_result and status == "completed":
            payload["result"] = result.result
        return payload

    @staticmethod
    def _map_state(state: str) -> str:
        if state in {"PENDING", "RECEIVED"}:
            return "queued"
        if state in {"STARTED", "PROGRESS"}:
            return "running"
        if state == "SUCCESS":
            return "completed"
        if state == "FAILURE":
            return "failed"
        if state == "REVOKED":
            return "cancelled"
        return "queued"
