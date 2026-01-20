export type RestPeriod = {
  start_date: string;
  end_date: string;
  days: number;
};

export type TimeoffDay = {
  date: string;
  base_kind: string;
  leave: string;
  locked: boolean;
  imposed: boolean;
  holiday_name?: string | null;
  reason?: string | null;
};

export type CountryOption = {
  name: string;
  code: string | null;
};

export type CityOption = {
  city: string;
  country: string;
  iata: string;
};

export type TimeoffSummary = {
  day_map?: TimeoffDay[];
  rest_periods: RestPeriod[];
  total_rest_days: number;
  used_leave_days: number;
  unused_leave_days: number;
  score: number;
  best_month?: {
    month: number;
    leave_days: number;
    rest_days: number;
    efficiency: number;
  } | null;
  efficiency_ranking?: Array<{
    month: number;
    leave_days: number;
    rest_days: number;
    efficiency: number;
  }>;
};

export type MetaInfo = {
  locale: string;
  timezone: string;
  currency: string;
  date_format?: string;
  datetime_format?: string;
};

export type DestinationSuggestion = {
  rest_period: RestPeriod;
  country: string;
  country_code?: string | null;
  cities: string[];
  source_iata: string[];
  destination_iatas: string[];
  flight_hours?: number | null;
  haul_category?: string | null;
  climate?: {
    avg_temp_c?: number | null;
    precip_mm?: number | null;
    months?: number[];
    source?: string | null;
    source_year?: number | null;
  } | null;
  safety?: {
    level?: string | null;
    score?: number | null;
    message?: string | null;
    updated?: string | null;
    source?: string | null;
  } | null;
};

export type FlightOption = {
  origin_iata: string;
  destination_iata: string;
  depart_date: string;
  return_date: string | null;
  price: number | null;
  total_duration_min: number | null;
  stops: number | null;
  score: number | null;
  provider: string;
};

export type LodgingOption = {
  name: string;
  price_total: number | null;
  rating: number | null;
  location: string | null;
  score: number | null;
};

export type ItineraryPlan = {
  rest_period: RestPeriod;
  destination: DestinationSuggestion | null;
  flights: FlightOption[];
  lodging: LodgingOption[];
  notes: string | null;
};

export type PipelineResult = {
  meta?: MetaInfo;
  timeoff: TimeoffSummary;
  destinations: DestinationSuggestion[];
  flights: FlightOption[];
  lodging: LodgingOption[];
  itineraries: ItineraryPlan[];
};

export type FlightInsightOption = {
  origin_iata: string;
  destination_iata: string;
  depart_date: string;
  return_date: string | null;
  price: number | null;
  total_duration_min: number | null;
  stops: number | null;
  score: number | null;
  provider: string;
  flight_name?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  arrival_time_ahead?: string | null;
  duration?: string | null;
  trip_type?: string | null;
  itinerary_route?: string | null;
  segment_route_group?: string | null;
  segment_index?: number | null;
  segment_span?: number | null;
  trip_start_date?: string | null;
  trip_end_date?: string | null;
  trip_nights?: number | null;
};

export type ArtifactLink = {
  name: string;
  url: string;
};

export type FlightInsightsResult = {
  meta?: MetaInfo;
  summary: {
    origin_airports: string[];
    destination_airports: string[];
    depart_start: string;
    depart_end: string;
    return_start: string;
    return_end: string;
    currency: string;
    options: number;
  };
  top_price: FlightInsightOption[];
  top_duration: FlightInsightOption[];
  top_fewest_stops: FlightInsightOption[];
  top_score: FlightInsightOption[];
  artifacts?: {
    flights_csv?: ArtifactLink;
    flights_clean_csv?: ArtifactLink;
    summary_csv?: ArtifactLink;
    summary_clean_csv?: ArtifactLink;
    report_excel?: ArtifactLink;
  };
};

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type JobInfo = {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  stage: string;
  created_at: number;
  updated_at: number;
  error?: string | null;
};

export type JobDetail = JobInfo & {
  result?: FlightInsightsResult | null;
};
