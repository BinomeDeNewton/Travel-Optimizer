"""Request schemas for the Travel Optimizer API."""

from __future__ import annotations

from datetime import date
from typing import List, Optional

from pydantic import BaseModel, Field


class PipelinePayload(BaseModel):
    year: int = Field(..., ge=2000)
    leave_days: int = Field(..., ge=0)
    country_code: str = Field("FR", min_length=2, max_length=2)
    min_rest: int = Field(3, ge=1)
    home_city: Optional[str] = None
    preferred_cities: List[str] = Field(default_factory=list)
    preferred_countries: List[str] = Field(default_factory=list)
    haul_types: List[str] = Field(default_factory=list)
    max_destinations: int = Field(10, ge=1)
    max_flights_per_destination: int = Field(5, ge=0)
    max_lodging_per_destination: int = Field(5, ge=0)
    include_flights: bool = True
    budget: Optional[float] = None
    currency: str = "EUR"


class FlightInsightsPayload(BaseModel):
    origin_country_code: str = Field(..., min_length=2)
    origin_city: Optional[str] = None
    destination_countries: List[str] = Field(default_factory=list)
    depart_start: date
    depart_end: date
    return_start: date
    return_end: date
    currency: str = "EUR"
    max_airports_per_country: int = Field(0, ge=0)
    max_origin_airports: int = Field(0, ge=0)
    max_airport_pairs: int = Field(0, ge=0)
    max_combinations: int = Field(0, ge=0)
    max_flight_options: int = Field(0, ge=0)
    max_calls: int = Field(0, ge=0)
    top_n: int = Field(3, ge=1)
