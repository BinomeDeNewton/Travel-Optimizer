"""Celery application for optional Redis-backed job queue."""

from __future__ import annotations

import os

from celery import Celery


def _env(name: str, default: str) -> str:
    return os.getenv(name, default)


BROKER_URL = _env("CELERY_BROKER_URL", "redis://localhost:6379/0")
RESULT_BACKEND = _env("CELERY_RESULT_BACKEND", "redis://localhost:6379/1")

celery_app = Celery("travel_optimizer", broker=BROKER_URL, backend=RESULT_BACKEND)
celery_app.conf.update(
    task_track_started=True,
    task_ignore_result=False,
    broker_connection_retry_on_startup=True,
)
celery_app.autodiscover_tasks(["travel_optimizer.api"], related_name="celery_tasks")
