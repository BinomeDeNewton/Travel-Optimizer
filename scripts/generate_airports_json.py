"""Generate minimal geo JSON assets for the web UI."""

from __future__ import annotations

import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "data" / "flights_data" / "airports.dat"
OUTPUT_AIRPORTS = ROOT / "web" / "public" / "airports.json"
OUTPUT_COUNTRIES = ROOT / "web" / "public" / "countries.json"
OUTPUT_CITIES = ROOT / "web" / "public" / "cities.json"


def main() -> int:
    if not INPUT.exists():
        raise SystemExit(f"Missing airports.dat at {INPUT}")

    mapping: dict[str, list[float]] = {}
    countries: dict[str, str | None] = {}
    cities: dict[tuple[str, str], dict[str, str]] = {}
    with INPUT.open("r", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if len(row) < 8:
                continue
            iata = row[4].strip()
            if not iata or iata == "\\N":
                continue
            try:
                lat = float(row[6])
                lon = float(row[7])
            except ValueError:
                continue
            mapping[iata] = [lon, lat]
            countries.setdefault(row[3], None)
            key = (row[2], row[3])
            if key not in cities:
                cities[key] = {"city": row[2], "country": row[3], "iata": iata}

    try:
        import pycountry

        for country_name in list(countries):
            match = pycountry.countries.get(name=country_name)
            if match:
                countries[country_name] = match.alpha_2
            else:
                try:
                    fuzzy = pycountry.countries.search_fuzzy(country_name)
                    if fuzzy:
                        countries[country_name] = fuzzy[0].alpha_2
                except LookupError:
                    continue
    except Exception:
        pass

    OUTPUT_AIRPORTS.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_AIRPORTS.open("w", encoding="utf-8") as handle:
        json.dump(mapping, handle, ensure_ascii=True, indent=2)

    countries_payload = [
        {"name": name, "code": code}
        for name, code in sorted(countries.items(), key=lambda item: item[0])
    ]
    with OUTPUT_COUNTRIES.open("w", encoding="utf-8") as handle:
        json.dump(countries_payload, handle, ensure_ascii=True, indent=2)

    cities_payload = sorted(cities.values(), key=lambda item: (item["country"], item["city"]))
    with OUTPUT_CITIES.open("w", encoding="utf-8") as handle:
        json.dump(cities_payload, handle, ensure_ascii=True, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
