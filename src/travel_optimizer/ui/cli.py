"""CLI entry point for the travel optimizer pipeline."""

from __future__ import annotations

import argparse
from pathlib import Path

from travel_optimizer.adapters.io.exports import serialize_pipeline_result
from travel_optimizer.adapters.storage.repositories import write_json
from travel_optimizer.core.config import load_paths
from travel_optimizer.core.models import PipelineRequest, TimeoffRequest
from travel_optimizer.core.normalization import build_meta, normalize_currency
from travel_optimizer.pipeline.orchestrator import Orchestrator


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Travel Optimizer CLI")
    parser.add_argument("--year", type=int, required=True, help="Target year")
    parser.add_argument("--leave", type=int, required=True, help="Total leave days available")
    parser.add_argument("--country", type=str, default="FR", help="Country code (default: FR)")
    parser.add_argument("--min-rest", type=int, default=3, help="Minimum rest period length")
    parser.add_argument("--output", type=str, default="outputs/reports/pipeline.json", help="Output JSON path")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    timeoff = TimeoffRequest(
        year=args.year,
        total_leave_days=args.leave,
        country_code=args.country,
        min_rest_length=args.min_rest,
    )
    request = PipelineRequest(timeoff=timeoff)
    currency = normalize_currency(request.currency)

    orchestrator = Orchestrator(paths=load_paths())
    result = orchestrator.run(request)

    payload = serialize_pipeline_result(result)
    payload["meta"] = build_meta(currency)
    output_path = Path(args.output)
    write_json(output_path, payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
