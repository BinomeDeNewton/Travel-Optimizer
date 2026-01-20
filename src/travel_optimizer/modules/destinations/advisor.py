"""Destination advisor based on rest periods and flight connectivity."""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Dict, Iterable, List, Optional

try:
    import pycountry
except Exception:  # pragma: no cover - optional dependency
    pycountry = None

from travel_optimizer.core.models import DestinationSuggestion, RestPeriod
from travel_optimizer.modules.destinations.enrichment import enrich_suggestions


@dataclass
class AirportInfo:
    iata: str
    name: str
    city: str
    country: str
    lat: float
    lon: float


@dataclass
class RouteInfo:
    source: str
    destination: str
    stops: int


class DestinationAdvisor:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.airports: Dict[str, AirportInfo] = {}
        self.routes: List[RouteInfo] = []
        self.airport_frequencies: Dict[str, int] = {}
        self._loaded = False

    def _resolve_flights_data_dir(self) -> Path:
        candidate = self.data_dir / "flights_data"
        if candidate.exists():
            return candidate
        return self.data_dir

    def load(self) -> None:
        if self._loaded:
            return
        flights_data = self._resolve_flights_data_dir()
        airports_path = flights_data / "airports.dat"
        routes_path = flights_data / "routes.dat"

        if airports_path.exists():
            with open(airports_path, encoding="utf-8") as handle:
                reader = csv.reader(handle)
                for row in reader:
                    if len(row) < 8:
                        continue
                    iata = row[4]
                    if not iata or iata == "\\N":
                        continue
                    try:
                        lat = float(row[6])
                        lon = float(row[7])
                    except ValueError:
                        continue
                    self.airports[iata] = AirportInfo(
                        iata=iata,
                        name=row[1],
                        city=row[2],
                        country=row[3],
                        lat=lat,
                        lon=lon,
                    )

        if routes_path.exists():
            with open(routes_path, encoding="utf-8") as handle:
                reader = csv.reader(handle)
                for row in reader:
                    if len(row) < 8:
                        continue
                    source_iata = row[2]
                    dest_iata = row[4]
                    try:
                        stops = int(row[7])
                    except ValueError:
                        stops = 0
                    if source_iata and dest_iata:
                        self.routes.append(RouteInfo(source=source_iata, destination=dest_iata, stops=stops))

        for route in self.routes:
            self.airport_frequencies[route.source] = self.airport_frequencies.get(route.source, 0) + 1
            self.airport_frequencies[route.destination] = self.airport_frequencies.get(route.destination, 0) + 1

        self._loaded = True

    @staticmethod
    def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
        dlon = lon2 - lon1
        dlat = lat2 - lat1
        a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
        c = 2 * math.asin(math.sqrt(a))
        return 6371 * c

    def _estimate_flight_duration(self, source_iata: str, destination_iata: str) -> Optional[float]:
        source = self.airports.get(source_iata)
        destination = self.airports.get(destination_iata)
        if not source or not destination:
            return None
        distance = self._haversine(source.lat, source.lon, destination.lat, destination.lon)
        avg_speed = 900
        return distance / avg_speed

    @staticmethod
    def _get_vacation_recommendation(flight_hours: float) -> tuple[int, int]:
        if flight_hours < 3:
            return 3, 5
        if flight_hours < 6:
            return 5, 7
        if flight_hours < 12:
            return 7, 14
        return 14, 35

    def _country_name(self, country_code: str) -> Optional[str]:
        if not country_code:
            return None
        if pycountry:
            country = pycountry.countries.get(alpha_2=country_code.upper())
            if country:
                return country.name
        return None

    def _country_code(self, country_name: str) -> Optional[str]:
        if not country_name or not pycountry:
            return None
        try:
            match = pycountry.countries.get(name=country_name)
            if match:
                return match.alpha_2
            matches = pycountry.countries.search_fuzzy(country_name)
            if matches:
                return matches[0].alpha_2
        except LookupError:
            return None
        return None

    def _most_frequented_airport(self, country: str, exclude_cities: Optional[List[str]] = None) -> Optional[str]:
        exclude_cities = exclude_cities or []
        most_frequented_iata = None
        highest_frequency = -1
        for iata, airport in self.airports.items():
            if airport.country == country and airport.city not in exclude_cities:
                freq = self.airport_frequencies.get(iata, 0)
                if freq > highest_frequency:
                    most_frequented_iata = iata
                    highest_frequency = freq
        return most_frequented_iata

    def _destination_iatas(self, country: str, cities: List[str]) -> List[str]:
        if not cities:
            iata = self._most_frequented_airport(country)
            return [iata] if iata else []

        cities_iata: List[str] = []
        for city in cities:
            for iata, airport in self.airports.items():
                if airport.country == country and airport.city.lower() == city.lower():
                    cities_iata.append(iata)
        if not cities_iata:
            fallback = self._most_frequented_airport(country, exclude_cities=cities)
            if fallback:
                cities_iata.append(fallback)
        return list(set(cities_iata))

    def _resolve_user_airports(self, country_name: str, home_city: Optional[str]) -> List[str]:
        if home_city:
            matches = [
                iata
                for iata, airport in self.airports.items()
                if airport.country == country_name and airport.city.lower() == home_city.lower()
            ]
            if matches:
                return matches
        return [iata for iata, airport in self.airports.items() if airport.country == country_name]

    def _expand_interest(
        self,
        preferred_cities: Optional[List[str]],
        preferred_countries: Optional[List[str]],
    ) -> Dict[str, List[str]]:
        interests: Dict[str, List[str]] = {}

        if preferred_countries:
            for country in preferred_countries:
                key = country.strip()
                if key:
                    interests.setdefault(key, [])

        if preferred_cities:
            for city in preferred_cities:
                if not city:
                    continue
                for airport in self.airports.values():
                    if airport.city.lower() == city.lower():
                        interests.setdefault(airport.country, [])
                        if city not in interests[airport.country]:
                            interests[airport.country].append(city)
                        break

        return interests

    @staticmethod
    def _classify_haul(flight_hours: Optional[float]) -> Optional[str]:
        if flight_hours is None:
            return None
        if flight_hours < 3:
            return "short"
        if flight_hours < 6:
            return "medium"
        if flight_hours < 12:
            return "long"
        return "ultra"

    def suggest(
        self,
        country_code: str,
        rest_periods: Iterable[RestPeriod],
        *,
        home_city: Optional[str] = None,
        preferred_cities: Optional[List[str]] = None,
        preferred_countries: Optional[List[str]] = None,
        haul_types: Optional[List[str]] = None,
    ) -> List[DestinationSuggestion]:
        self.load()
        country_name = self._country_name(country_code) or country_code
        user_airports = self._resolve_user_airports(country_name, home_city)

        interests = self._expand_interest(preferred_cities, preferred_countries)
        preferred_country_set = {c.lower() for c in preferred_countries or []}
        preferred_city_set = {c.lower() for c in preferred_cities or []}
        haul_set = {h.lower() for h in (haul_types or []) if h}

        if not interests:
            return []

        suggestions: List[DestinationSuggestion] = []
        for period in rest_periods:
            duration_days = period.days
            destinations_info: Dict[str, Dict[str, List[str]]] = {}

            for route in self.routes:
                if route.source not in user_airports:
                    continue
                dest_airport = self.airports.get(route.destination)
                if not dest_airport:
                    continue
                flight_duration_hours = self._estimate_flight_duration(route.source, route.destination)
                if flight_duration_hours is None:
                    continue
                low, high = self._get_vacation_recommendation(flight_duration_hours)
                if duration_days < low or duration_days > high:
                    continue
                dest_country = dest_airport.country
                if dest_country not in interests:
                    continue
                if preferred_country_set and dest_country.lower() not in preferred_country_set:
                    continue
                if dest_country not in destinations_info:
                    cities = interests[dest_country]
                    destinations_info[dest_country] = {
                        "cities": list(set(cities)),
                        "source_iata": [route.source],
                        "destination_iata": self._destination_iatas(dest_country, cities),
                    }
                else:
                    if route.source not in destinations_info[dest_country]["source_iata"]:
                        destinations_info[dest_country]["source_iata"].append(route.source)

            for country, info in destinations_info.items():
                if preferred_city_set:
                    if not any(city.lower() in preferred_city_set for city in info["cities"]):
                        continue

                flight_hours = None
                for origin in info["source_iata"]:
                    for dest in info["destination_iata"]:
                        hours = self._estimate_flight_duration(origin, dest)
                        if hours is None:
                            continue
                        if flight_hours is None or hours < flight_hours:
                            flight_hours = hours

                haul_category = self._classify_haul(flight_hours)
                if haul_set and (haul_category or "").lower() not in haul_set:
                    continue

                suggestions.append(
                    DestinationSuggestion(
                        rest_period=period,
                        country=country,
                        country_code=self._country_code(country),
                        cities=info["cities"],
                        source_iata=info["source_iata"],
                        destination_iatas=info["destination_iata"],
                        flight_hours=round(flight_hours, 2) if flight_hours is not None else None,
                        haul_category=haul_category,
                    )
                )
        return suggestions


def suggest_destinations(
    *,
    country_code: str,
    rest_periods: Iterable[RestPeriod],
    data_dir: Path,
    cache_dir: Optional[Path] = None,
    max_destinations: int = 10,
    home_city: Optional[str] = None,
    preferred_cities: Optional[List[str]] = None,
    preferred_countries: Optional[List[str]] = None,
    haul_types: Optional[List[str]] = None,
) -> List[DestinationSuggestion]:
    advisor = DestinationAdvisor(data_dir)
    suggestions = advisor.suggest(
        country_code,
        rest_periods,
        home_city=home_city,
        preferred_cities=preferred_cities,
        preferred_countries=preferred_countries,
        haul_types=haul_types,
    )
    trimmed = suggestions[:max_destinations]
    if cache_dir:
        return enrich_suggestions(trimmed, airports=advisor.airports, cache_dir=cache_dir)
    return trimmed
