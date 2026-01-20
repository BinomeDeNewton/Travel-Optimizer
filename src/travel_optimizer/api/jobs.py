"""In-memory job queue with progress tracking."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional
from concurrent.futures import Future, ThreadPoolExecutor


class JobCancelled(Exception):
    """Raised when a job is cancelled."""


@dataclass
class Job:
    id: str
    kind: str
    status: str
    progress: float
    stage: str
    created_at: float
    updated_at: float
    result: Optional[dict] = None
    error: Optional[str] = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    future: Optional[Future] = None
    process: Any = None

    def to_dict(self, *, include_result: bool = False) -> Dict[str, Any]:
        payload = {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": round(self.progress, 3),
            "stage": self.stage,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "error": self.error,
        }
        if include_result:
            payload["result"] = self.result
        return payload


class JobQueue:
    def __init__(self, *, max_workers: int = 2) -> None:
        self._lock = threading.Lock()
        self._jobs: Dict[str, Job] = {}
        self._executor = ThreadPoolExecutor(max_workers=max_workers)

    def submit(self, kind: str, target: Callable[[Job], dict], *args: Any, **kwargs: Any) -> Job:
        job_id = uuid.uuid4().hex
        now = time.time()
        job = Job(
            id=job_id,
            kind=kind,
            status="queued",
            progress=0.0,
            stage="Queued",
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._jobs[job_id] = job
        job.future = self._executor.submit(self._run_job, job_id, target, *args, **kwargs)
        return job

    def _run_job(self, job_id: str, target: Callable[[Job], dict], *args: Any, **kwargs: Any) -> None:
        job = self.get(job_id)
        if not job:
            return
        self.update(job_id, status="running", stage="Starting", progress=0.02)
        try:
            result = target(job, *args, **kwargs)
            if job.cancel_event.is_set():
                self.update(job_id, status="cancelled", stage="Cancelled", progress=job.progress)
            else:
                job.result = result
                self.update(job_id, status="completed", stage="Complete", progress=1.0)
        except JobCancelled:
            self.update(job_id, status="cancelled", stage="Cancelled", progress=job.progress)
        except Exception as exc:  # pragma: no cover - defensive
            self.update(job_id, status="failed", stage="Failed", error=str(exc))

    def update(
        self,
        job_id: str,
        *,
        status: Optional[str] = None,
        stage: Optional[str] = None,
        progress: Optional[float] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            if status:
                job.status = status
            if stage:
                job.stage = stage
            if progress is not None:
                job.progress = max(0.0, min(progress, 1.0))
            if error:
                job.error = error
            job.updated_at = time.time()

    def set_process(self, job_id: str, process: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.process = process

    def cancel(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            job.cancel_event.set()
            process = job.process
        if process is not None:
            try:
                process.terminate()
            except Exception:
                pass
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda item: item.created_at, reverse=True)
