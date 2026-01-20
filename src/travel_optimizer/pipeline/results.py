"""Pipeline step results and diagnostics."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class StepReport:
    name: str
    ok: bool
    message: Optional[str] = None
    payload: Optional[Any] = None
