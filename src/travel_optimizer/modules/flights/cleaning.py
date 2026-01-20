#!/usr/bin/env python3
import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


def load_summary_csv(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def parse_float(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "none":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "none":
        return None
    try:
        return int(text)
    except ValueError:
        try:
            return int(float(text))
        except ValueError:
            return None


def parse_date(value: Optional[str]) -> Optional[datetime.date]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def parse_duration_minutes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    text = value.lower()
    hours = 0
    minutes = 0
    match = re.search(r"(\d+)\s*(?:hr|hrs|hour|hours|h)\b", text)
    if match:
        hours = int(match.group(1))
    match = re.search(r"(\d+)\s*(?:min|mins|minute|minutes|m)\b", text)
    if match:
        minutes = int(match.group(1))
    if hours == 0 and minutes == 0:
        return None
    return hours * 60 + minutes


def parse_time_minutes(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    match = re.search(r"(\d{1,2}):(\d{2})\s*([AP]M)", value)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    meridiem = match.group(3)
    if meridiem == "AM":
        if hour == 12:
            hour = 0
    else:
        if hour != 12:
            hour += 12
    return hour * 60 + minute


def is_night_segment(
    departure: Optional[str],
    arrival: Optional[str],
    arrival_time_ahead: Optional[str],
) -> int:
    if arrival_time_ahead:
        return 1
    dep_minutes = parse_time_minutes(departure)
    arr_minutes = parse_time_minutes(arrival)
    if dep_minutes is not None and (dep_minutes >= 22 * 60 or dep_minutes < 6 * 60):
        return 1
    if arr_minutes is not None and arr_minutes < 6 * 60:
        return 1
    return 0


def load_config(path: Optional[str]) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def get_currency(config: Dict[str, Any], fallback: str) -> str:
    fetch_cfg = config.get("fetch", {}) if config else {}
    currency = fetch_cfg.get("currency") or ""
    return currency or fallback


def get_weights(config: Dict[str, Any]) -> Dict[str, float]:
    scoring_cfg = config.get("scoring", {}) if config else {}
    weights_cfg = scoring_cfg.get("weights", {}) if scoring_cfg else {}
    weights = {
        "price": float(weights_cfg.get("price", 0.6)),
        "duration": float(weights_cfg.get("duration", 0.2)),
        "stops": float(weights_cfg.get("stops", 0.15)),
        "night": float(weights_cfg.get("night", 0.05)),
    }
    weight_sum = sum(weights.values())
    if weight_sum <= 0:
        return {"price": 1.0, "duration": 0.0, "stops": 0.0, "night": 0.0}
    return {key: value / weight_sum for key, value in weights.items()}


def score_key(row: Dict[str, Any]) -> Tuple[int, float]:
    score = row.get("score")
    if score is None:
        return (1, 0.0)
    return (0, float(score))


def valid_metric(row: Dict[str, Any], key: str) -> bool:
    return row.get(key) is not None


def format_top_path(base_path: str, name: str) -> str:
    return f"{base_path}_{name}.csv"


def compute_summary_metrics(row: Dict[str, Any]) -> Dict[str, Any]:
    duration_min = row.get("total_duration_min")
    duration_hours = None
    if duration_min is not None and duration_min > 0:
        duration_hours = round(duration_min / 60.0, 2)
    price_per_night = None
    if row.get("min_total_price") and row.get("trip_nights"):
        if row["trip_nights"] > 0:
            price_per_night = round(row["min_total_price"] / row["trip_nights"], 2)
    price_per_hour = None
    if row.get("min_total_price") and duration_hours:
        if duration_hours > 0:
            price_per_hour = round(row["min_total_price"] / duration_hours, 2)
    enriched = dict(row)
    enriched["duration_hours"] = duration_hours
    enriched["price_per_night"] = price_per_night
    enriched["price_per_hour"] = price_per_hour
    return enriched


def sort_key_asc(value: Optional[float]) -> Tuple[bool, float]:
    return (value is None, value if value is not None else float("inf"))


def sort_key_desc(value: Optional[float]) -> Tuple[bool, float]:
    return (value is None, -(value if value is not None else 0.0))


def write_csv(path: str, headers: List[str], rows: List[Dict[str, Any]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in headers})


def write_report_excel(
    *,
    report_path: str,
    flights_path: str,
    summary_path: str,
    top_data: Dict[str, List[Dict[str, Any]]],
    summary_headers: List[str],
    top_headers: List[str],
) -> None:
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)

    def write_sheet(name: str, headers: List[str], rows: List[Dict[str, Any]]) -> None:
        ws = wb.create_sheet(title=name)
        ws.append(headers)
        for row in rows:
            ws.append([row.get(col) for col in headers])
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    # Flights clean
    with open(flights_path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        flights_headers = reader.fieldnames or []
        flights_rows = list(reader)
    if flights_headers:
        write_sheet("Flights_Clean", flights_headers, flights_rows)

    # Summary clean
    with open(summary_path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        summary_rows = list(reader)
    write_sheet("Summary_Clean", summary_headers, summary_rows)

    # Tops
    for name, rows in top_data.items():
        write_sheet(name, top_headers, rows)

    wb.save(report_path)


def clean_flights(
    *,
    input_path: str,
    output_path: str,
    summary_path: Optional[str],
    rejected_path: Optional[str],
    config_path: Optional[str],
    tops_limit: int = 10,
    write_tops: bool = True,
    report_path: Optional[str] = None,
) -> None:
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Missing input file: {input_path}")

    config = load_config(config_path)
    weights = get_weights(config)

    summary_best: Dict[Tuple[str, int], Dict[str, Any]] = {}
    summary_meta: Dict[str, Dict[str, Any]] = {}
    rejected_rows = []
    top_paths: List[str] = []

    kept_count = 0
    rejected_count = 0

    with open(input_path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        fieldnames = reader.fieldnames or []
        if not fieldnames:
            raise ValueError("Input CSV is missing headers.")

        with open(output_path, "w", newline="", encoding="utf-8") as out_handle:
            writer = csv.DictWriter(out_handle, fieldnames=fieldnames)
            writer.writeheader()

            for row in reader:
                itinerary_id = row.get("itinerary_id") or ""
                if itinerary_id:
                    meta = summary_meta.setdefault(
                        itinerary_id,
                        {
                            "route": "",
                            "trip_start": None,
                            "trip_end": None,
                            "trip_nights": None,
                            "max_segment_index": None,
                            "max_query_index": None,
                            "trip_type_by_query": {},
                            "currency": row.get("price_currency") or "",
                        },
                    )

                    if row.get("itinerary_route"):
                        meta["route"] = row["itinerary_route"]

                    seg_date = parse_date(row.get("segment_date"))
                    if seg_date:
                        if meta["trip_start"] is None or seg_date < meta["trip_start"]:
                            meta["trip_start"] = seg_date
                        if meta["trip_end"] is None or seg_date > meta["trip_end"]:
                            meta["trip_end"] = seg_date

                    start_date = parse_date(row.get("trip_start_date"))
                    if start_date and (meta["trip_start"] is None or start_date < meta["trip_start"]):
                        meta["trip_start"] = start_date
                    end_date = parse_date(row.get("trip_end_date"))
                    if end_date and (meta["trip_end"] is None or end_date > meta["trip_end"]):
                        meta["trip_end"] = end_date

                    trip_nights = parse_int(row.get("trip_nights"))
                    if trip_nights is not None:
                        meta["trip_nights"] = trip_nights

                    segment_index = parse_int(row.get("segment_index"))
                    if segment_index is not None:
                        current_max = meta["max_segment_index"]
                        if current_max is None or segment_index > current_max:
                            meta["max_segment_index"] = segment_index

                    query_index = parse_int(row.get("query_index"))
                    if query_index is not None:
                        current_max = meta["max_query_index"]
                        if current_max is None or query_index > current_max:
                            meta["max_query_index"] = query_index
                        trip_type = row.get("trip_type")
                        if trip_type:
                            meta["trip_type_by_query"][query_index] = trip_type

                price_value = parse_float(row.get("price_value"))
                duration_min = parse_duration_minutes(row.get("duration"))
                valid_price = price_value is not None and price_value > 0
                valid_duration = duration_min is not None and duration_min > 0

                if not (valid_price and valid_duration):
                    rejected_count += 1
                    if rejected_path:
                        reject_row = dict(row)
                        reasons = []
                        if not valid_price:
                            reasons.append("invalid_price")
                        if not valid_duration:
                            reasons.append("invalid_duration")
                        reject_row["reject_reason"] = "|".join(reasons)
                        rejected_rows.append(reject_row)
                    continue

                kept_count += 1
                writer.writerow(row)

                if not itinerary_id:
                    continue
                query_index = parse_int(row.get("query_index"))
                if query_index is None:
                    continue

                key = (itinerary_id, query_index)
                current_best = summary_best.get(key)
                if current_best is None or price_value < current_best["price_value"]:
                    stops_value = parse_int(row.get("stops"))
                    night_flag = is_night_segment(
                        row.get("departure"),
                        row.get("arrival"),
                        row.get("arrival_time_ahead"),
                    )
                    summary_best[key] = {
                        "price_value": price_value,
                        "duration_min": duration_min,
                        "stops": stops_value,
                        "night": night_flag,
                        "from_airport": row.get("from_airport"),
                        "to_airport": row.get("to_airport"),
                        "airline": row.get("flight_name"),
                    }

    if rejected_path and rejected_rows:
        reject_fields = (fieldnames or []) + ["reject_reason"]
        with open(rejected_path, "w", newline="", encoding="utf-8") as reject_handle:
            writer = csv.DictWriter(reject_handle, fieldnames=reject_fields)
            writer.writeheader()
            for row in rejected_rows:
                writer.writerow(row)

    if summary_path:
        currency = get_currency(config, "")
        summary_rows = []
        for itinerary_id, meta in summary_meta.items():
            max_query_index = meta.get("max_query_index")
            queries = max_query_index + 1 if max_query_index is not None else 0
            segment_prices = []
            segment_airports = []
            segment_airlines = []
            priced_segments = 0
            total_price = 0.0
            total_duration = 0
            total_stops = 0
            night_segments = 0
            duration_ok = True
            stops_ok = True

            for query_idx in range(queries):
                entry = summary_best.get((itinerary_id, query_idx))
                if not entry:
                    segment_prices.append("")
                    segment_airports.append("")
                    segment_airlines.append("")
                    continue
                segment_prices.append(str(entry["price_value"]))
                from_airport = entry.get("from_airport")
                to_airport = entry.get("to_airport")
                if from_airport and to_airport:
                    segment_airports.append(f"{from_airport}-{to_airport}")
                else:
                    segment_airports.append("")
                segment_airlines.append(entry.get("airline") or "")
                priced_segments += 1
                total_price += entry["price_value"]
                if entry["duration_min"] is None:
                    duration_ok = False
                else:
                    total_duration += entry["duration_min"]
                if entry["stops"] is None:
                    stops_ok = False
                else:
                    total_stops += entry["stops"]
                night_segments += int(entry.get("night", 0))

            trip_types = meta.get("trip_type_by_query", {})
            trip_types_list = [trip_types[idx] for idx in sorted(trip_types)]

            trip_start = meta.get("trip_start")
            trip_end = meta.get("trip_end")
            trip_nights = meta.get("trip_nights")
            if trip_nights is None and trip_start and trip_end:
                trip_nights = (trip_end - trip_start).days

            row = {
                "itinerary_id": itinerary_id,
                "itinerary_route": meta.get("route") or "",
                "trip_start_date": trip_start.isoformat() if trip_start else "",
                "trip_end_date": trip_end.isoformat() if trip_end else "",
                "trip_nights": trip_nights,
                "segments": (meta.get("max_segment_index") or 0) + 1 if meta.get("max_segment_index") is not None else 0,
                "query_count": queries,
                "trip_types": ",".join(trip_types_list),
                "priced_segments": priced_segments,
                "min_total_price": total_price if priced_segments == queries and queries > 0 else None,
                "total_duration_min": total_duration if duration_ok and priced_segments == queries and queries > 0 else None,
                "total_stops": total_stops if stops_ok and priced_segments == queries and queries > 0 else None,
                "night_segments": night_segments if priced_segments == queries and queries > 0 else None,
                "score": None,
                "price_currency": currency or meta.get("currency") or "",
                "segment_min_prices": "|".join(segment_prices),
                "segment_best_airports": "|".join(segment_airports),
                "segment_best_airlines": "|".join(segment_airlines),
            }
            summary_rows.append(row)

        eligible = [
            row
            for row in summary_rows
            if valid_metric(row, "min_total_price")
            and valid_metric(row, "total_duration_min")
            and valid_metric(row, "total_stops")
            and valid_metric(row, "night_segments")
        ]
        if eligible:
            price_values = [row["min_total_price"] for row in eligible]
            duration_values = [row["total_duration_min"] for row in eligible]
            stops_values = [row["total_stops"] for row in eligible]
            night_values = [row["night_segments"] for row in eligible]

            price_min, price_max = min(price_values), max(price_values)
            dur_min, dur_max = min(duration_values), max(duration_values)
            stops_min, stops_max = min(stops_values), max(stops_values)
            night_min, night_max = min(night_values), max(night_values)

            def normalize(value: float, min_value: float, max_value: float) -> float:
                if max_value <= min_value:
                    return 0.0
                return (value - min_value) / (max_value - min_value)

            for row in eligible:
                price_norm = normalize(row["min_total_price"], price_min, price_max)
                dur_norm = normalize(row["total_duration_min"], dur_min, dur_max)
                stops_norm = normalize(row["total_stops"], stops_min, stops_max)
                night_norm = normalize(row["night_segments"], night_min, night_max)
                score = 1.0 - (
                    weights["price"] * price_norm
                    + weights["duration"] * dur_norm
                    + weights["stops"] * stops_norm
                    + weights["night"] * night_norm
                )
                row["score"] = round(max(0.0, min(1.0, score)) * 100, 2)

        summary_rows.sort(key=score_key, reverse=True)

        summary_headers = [
            "itinerary_id",
            "itinerary_route",
            "trip_start_date",
            "trip_end_date",
            "trip_nights",
            "segments",
            "query_count",
            "trip_types",
            "priced_segments",
            "min_total_price",
            "total_duration_min",
            "total_stops",
            "night_segments",
            "score",
            "price_currency",
            "segment_min_prices",
            "segment_best_airports",
            "segment_best_airlines",
        ]
        write_csv(summary_path, summary_headers, summary_rows)

        top_headers = summary_headers + ["duration_hours", "price_per_night", "price_per_hour"]
        top_data: Dict[str, List[Dict[str, Any]]] = {}
        summary_extended = [compute_summary_metrics(row) for row in summary_rows]

        top_paths = []
        if write_tops:
            base_path = os.path.splitext(summary_path)[0]
            top_data = {
                "Top_Score": sorted(
                    summary_extended,
                    key=lambda r: (
                        sort_key_desc(r.get("score")),
                        sort_key_asc(r.get("min_total_price")),
                        sort_key_asc(r.get("total_duration_min")),
                    ),
                )[:tops_limit],
                "Top_Cheapest": sorted(
                    summary_extended,
                    key=lambda r: (
                        sort_key_asc(r.get("min_total_price")),
                        sort_key_desc(r.get("score")),
                    ),
                )[:tops_limit],
                "Top_Shortest": sorted(
                    summary_extended,
                    key=lambda r: (
                        sort_key_asc(r.get("total_duration_min")),
                        sort_key_desc(r.get("score")),
                        sort_key_asc(r.get("min_total_price")),
                    ),
                )[:tops_limit],
                "Top_Fewest_Stops": sorted(
                    summary_extended,
                    key=lambda r: (
                        sort_key_asc(r.get("total_stops")),
                        sort_key_desc(r.get("score")),
                        sort_key_asc(r.get("min_total_price")),
                    ),
                )[:tops_limit],
                "Top_Price_per_Night": sorted(
                    [r for r in summary_extended if r.get("price_per_night") is not None],
                    key=lambda r: (
                        sort_key_asc(r.get("price_per_night")),
                        sort_key_desc(r.get("score")),
                    ),
                )[:tops_limit],
            }

            for name, rows in top_data.items():
                path = format_top_path(base_path, name)
                write_csv(path, top_headers, rows)
                top_paths.append(path)

        if report_path is None:
            report_path = os.path.splitext(summary_path)[0] + "_report.xlsx"
        if report_path:
            try:
                write_report_excel(
                    report_path=report_path,
                    flights_path=output_path,
                    summary_path=summary_path,
                    top_data=top_data,
                    summary_headers=summary_headers,
                    top_headers=top_headers,
                )
            except Exception as exc:
                print(f"Report excel failed: {exc}", file=sys.stderr)

    print(
        "Cleaned {input} -> {output} (kept={kept}, rejected={rejected})".format(
            input=input_path,
            output=output_path,
            kept=kept_count,
            rejected=rejected_count,
        )
    )
    if rejected_path:
        print(f"Rejected rows: {rejected_path}")
    if summary_path:
        print(f"Clean summary: {summary_path}")
    if top_paths:
        print("Top CSVs: " + ", ".join(top_paths))
    if report_path:
        print(f"Report excel: {report_path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Clean flights.csv rows with invalid price or duration, and rebuild summary."
    )
    parser.add_argument("--input", default="flights.csv", help="Input flights CSV.")
    parser.add_argument(
        "--output", default="flights_clean.csv", help="Output cleaned flights CSV."
    )
    parser.add_argument(
        "--summary",
        default="flights_summary_clean.csv",
        help="Output cleaned summary CSV.",
    )
    parser.add_argument(
        "--rejected",
        default="flights_rejected.csv",
        help="Output rejected rows CSV.",
    )
    parser.add_argument(
        "--tops-limit",
        type=int,
        default=10,
        help="Number of rows to keep in each top CSV.",
    )
    parser.add_argument(
        "--no-tops",
        action="store_true",
        help="Disable top CSV generation.",
    )
    parser.add_argument(
        "--report",
        default=None,
        help="Excel report output path.",
    )
    parser.add_argument(
        "--config", default="flight_plan.json", help="Optional config for weights/currency."
    )
    args = parser.parse_args()

    clean_flights(
        input_path=args.input,
        output_path=args.output,
        summary_path=args.summary,
        rejected_path=args.rejected,
        config_path=args.config,
        tops_limit=args.tops_limit,
        write_tops=not args.no_tops,
        report_path=args.report,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
