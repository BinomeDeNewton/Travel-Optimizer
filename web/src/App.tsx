import { useEffect, useMemo, useState } from "react";
import type {
  CityOption,
  CountryOption,
  DestinationSuggestion,
  FlightInsightsResult,
  FlightOption,
  JobDetail,
  JobInfo,
  PipelineResult,
  RestPeriod
} from "./types";
import RoutesMap from "./components/RoutesMap";
import DestinationCountryPicker from "./components/DestinationCountryPicker";
import OriginCityPicker from "./components/OriginCityPicker";
import OriginCountryPicker from "./components/OriginCountryPicker";
import type { MultiSelectOption } from "./components/MultiSelect";
import TimeoffCalendar from "./components/TimeoffCalendar";
import { Input } from "./components/ui/input";
import { DayPicker } from "react-day-picker";
import type { DateRange } from "react-day-picker";
import {
  FormatConfig,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatJobTimestamp,
  formatMonths,
  parseISODate,
  toDateInputValue
} from "./utils/format";
import { buildChaslesItineraries, type CountryIdentity } from "./utils/itinerary";
import { continentOrder, getContinentLabel } from "./utils/continents";

const selectTopFlights = (flights: FlightOption[]) => {
  const sortable = [...flights];
  sortable.sort((a, b) => {
    const scoreA = a.score ?? Infinity;
    const scoreB = b.score ?? Infinity;
    if (scoreA !== scoreB) return scoreA - scoreB;
    const priceA = a.price ?? Infinity;
    const priceB = b.price ?? Infinity;
    return priceA - priceB;
  });
  return sortable.slice(0, 6);
};

const getRouteLabel = (flight: FlightOption) => `${flight.origin_iata} → ${flight.destination_iata}`;

const flagEmoji = (code?: string | null) => {
  if (!code) return "";
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length !== 2) return "";
  const [first, second] = trimmed;
  return String.fromCodePoint(127397 + first.charCodeAt(0), 127397 + second.charCodeAt(0));
};

const formatCityValue = (value: string) => value.split("|")[0]?.trim() ?? value;

const defaultDateOffset = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
};

const toICSDate = (value: string) => value.replace(/-/g, "");

const addDays = (value: string, days: number) => {
  const date = parseISODate(value);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
};

const toDateRange = (start: string, end: string): DateRange | undefined => {
  if (!start) return undefined;
  const from = parseISODate(start);
  const to = end ? parseISODate(end) : undefined;
  if (Number.isNaN(from.getTime())) return undefined;
  if (to && Number.isNaN(to.getTime())) return { from };
  return { from, to };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (start: string, end: string) => {
  const startDate = parseISODate(start);
  const endDate = parseISODate(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY);
  return Math.max(1, diffDays);
};

const countDaysInclusive = (start: string, end: string) => {
  const startDate = parseISODate(start);
  const endDate = parseISODate(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY);
  return Math.max(1, diffDays + 1);
};

const escapeICS = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

const haulOptions = [
  { value: "short", label: "Short-haul (<3h)" },
  { value: "medium", label: "Medium-haul (3-6h)" },
  { value: "long", label: "Long-haul (6-12h)" },
  { value: "ultra", label: "Ultra-long (12h+)" }
];

const makePeriodKey = (period: RestPeriod) => `${period.start_date}|${period.end_date}`;

const safetyClass = (level?: string | null) => {
  const value = (level ?? "").toLowerCase();
  if (value.includes("low")) return "safety-low";
  if (value.includes("moderate")) return "safety-moderate";
  if (value.includes("high")) return "safety-high";
  if (value.includes("critical")) return "safety-critical";
  return "safety-unknown";
};

const formatJobStatus = (status: JobInfo["status"]) => status.charAt(0).toUpperCase() + status.slice(1);

const formatJobKind = (kind: string) => kind.replace(/-/g, " ");
const LARGE_SCAN_THRESHOLD = 1200;

export default function App() {
  const [data, setData] = useState<PipelineResult | null>(null);
  const [source, setSource] = useState("No data loaded");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"optimizer" | "insights" | "queue">("optimizer");
  const [formatConfig, setFormatConfig] = useState<FormatConfig>(() => ({
    locale: navigator.language || "fr-FR",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris",
    currency: "EUR"
  }));

  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [cities, setCities] = useState<CityOption[]>([]);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [year, setYear] = useState(new Date().getFullYear());
  const [leaveDays, setLeaveDays] = useState(25);
  const [minRest, setMinRest] = useState(3);
  const [homeCountry, setHomeCountry] = useState<CountryOption | null>(null);
  const [homeCity, setHomeCity] = useState("");
  const [preferredCities, setPreferredCities] = useState<string[]>([]);
  const [preferredCountries, setPreferredCountries] = useState<string[]>([]);
  const [haulTypes, setHaulTypes] = useState<string[]>(["short", "medium", "long"]);
  const [fastMode, setFastMode] = useState(true);
  const [running, setRunning] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiStatus, setApiStatus] = useState<"checking" | "online" | "offline">("checking");
  const [lastPipelineRun, setLastPipelineRun] = useState<string | null>(null);
  const [lastInsightsRun, setLastInsightsRun] = useState<string | null>(null);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState<string | null>(null);
  const [hoveredPeriodKey, setHoveredPeriodKey] = useState<string | null>(null);

  const [destMinDays, setDestMinDays] = useState(0);
  const [destSort, setDestSort] = useState("rest-desc");
  const [destHaulFilter, setDestHaulFilter] = useState("all");

  const [insights, setInsights] = useState<FlightInsightsResult | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [insightsCountries, setInsightsCountries] = useState<string[]>([]);
  const [insightsOriginCountry, setInsightsOriginCountry] = useState<CountryOption | null>(null);
  const [insightsOriginCity, setInsightsOriginCity] = useState("");
  const [departStart, setDepartStart] = useState(defaultDateOffset(14));
  const [departEnd, setDepartEnd] = useState(defaultDateOffset(35));
  const [returnStart, setReturnStart] = useState(defaultDateOffset(21));
  const [returnEnd, setReturnEnd] = useState(defaultDateOffset(49));
  const [confirmLargeScan, setConfirmLargeScan] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const [lastInsightsFingerprint, setLastInsightsFingerprint] = useState<string | null>(null);
  const [lastInsightsJobId, setLastInsightsJobId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const [countriesRes, citiesRes] = await Promise.all([fetch("/countries.json"), fetch("/cities.json")]);
        if (!countriesRes.ok || !citiesRes.ok) {
          throw new Error("Missing countries.json or cities.json");
        }
        const countriesPayload = (await countriesRes.json()) as CountryOption[];
        const citiesPayload = (await citiesRes.json()) as CityOption[];
        setCountries(countriesPayload);
        setCities(citiesPayload);
      } catch (err) {
        setOptionsError("Location data missing. Run `make map-data` to regenerate.");
      }
    };
    loadOptions();
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setApiStatus("offline");
          return;
        }
        setApiStatus("online");
        try {
          const payload = (await response.json()) as { meta?: { locale?: string; timezone?: string; currency?: string } };
          if (payload.meta) {
            setFormatConfig((current) => ({
              locale: payload.meta?.locale ?? current.locale,
              timeZone: payload.meta?.timezone ?? current.timeZone,
              currency: payload.meta?.currency ?? current.currency
            }));
          }
        } catch {
          // ignore malformed meta payloads
        }
      })
      .catch(() => {
        if (active) setApiStatus("offline");
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  // Module 2 requires an explicit origin selection; no silent defaults.

  useEffect(() => {
    if (selectedPeriodKey || !data?.timeoff.rest_periods.length) return;
    setSelectedPeriodKey(makePeriodKey(data.timeoff.rest_periods[0]));
  }, [data, selectedPeriodKey]);

  const countryCodeByName = useMemo(() => {
    const map = new Map<string, string>();
    countries.forEach((entry) => {
      if (entry.code) {
        map.set(entry.name, entry.code);
      }
    });
    return map;
  }, [countries]);

  const countryByValue = useMemo(() => {
    const map = new Map<string, CountryOption>();
    countries.forEach((entry) => {
      map.set(entry.name, entry);
      if (entry.code) {
        map.set(entry.code, entry);
      }
    });
    return map;
  }, [countries]);

  const preferredCountryOptions = useMemo<MultiSelectOption[]>(() => {
    const ranks = new Map(continentOrder.map((label, index) => [label, index]));
    const options = countries.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.code ?? undefined,
      flag: flagEmoji(entry.code),
      group: getContinentLabel(entry.name)
    }));
    options.sort((a, b) => {
      const rankA = ranks.get(a.group ?? "Other") ?? ranks.size;
      const rankB = ranks.get(b.group ?? "Other") ?? ranks.size;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
    return options;
  }, [countries]);

  const originCountryOptions = useMemo<MultiSelectOption[]>(() => {
    const ranks = new Map(continentOrder.map((label, index) => [label, index]));
    const options = countries.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.code ?? undefined,
      flag: flagEmoji(entry.code),
      group: getContinentLabel(entry.name)
    }));
    options.sort((a, b) => {
      const rankA = ranks.get(a.group ?? "Other") ?? ranks.size;
      const rankB = ranks.get(b.group ?? "Other") ?? ranks.size;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
    return options;
  }, [countries]);

  const insightsCountryOptions = useMemo<MultiSelectOption[]>(() => {
    const ranks = new Map(continentOrder.map((label, index) => [label, index]));
    const options = countries.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.code ?? undefined,
      flag: flagEmoji(entry.code),
      group: getContinentLabel(entry.name)
    }));
    options.sort((a, b) => {
      const rankA = ranks.get(a.group ?? "Other") ?? ranks.size;
      const rankB = ranks.get(b.group ?? "Other") ?? ranks.size;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
    return options;
  }, [countries]);

  const cityOptions = useMemo<MultiSelectOption[]>(() => {
    if (!cities.length) return [];
    return cities.map((entry) => ({
      value: `${entry.city}|${entry.country}`,
      label: entry.city,
      hint: entry.country,
      flag: flagEmoji(countryCodeByName.get(entry.country)),
      group: entry.country
    }));
  }, [cities, countryCodeByName]);

  const homeCityPickerOptions = useMemo<MultiSelectOption[]>(() => {
    if (!homeCountry) return [];
    const cityMap = new Map<string, Set<string>>();
    cities
      .filter((entry) => entry.country === homeCountry.name)
      .slice(0, 240)
      .forEach((entry) => {
        const city = entry.city.trim();
        if (!city) return;
        if (!cityMap.has(city)) {
          cityMap.set(city, new Set());
        }
        if (entry.iata) {
          cityMap.get(city)?.add(entry.iata);
        }
      });
    const options = Array.from(cityMap.entries()).map(([city, codes]) => {
      const codesList = Array.from(codes).sort();
      return {
        value: city,
        label: city,
        hint: codesList.length ? codesList.join(", ") : undefined,
        group: city ? city[0].toUpperCase() : "Cities"
      };
    });
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [cities, homeCountry]);

  const homeCitySet = useMemo(() => new Set(homeCityPickerOptions.map((option) => option.value)), [homeCityPickerOptions]);

  const insightsOriginCities = useMemo(() => {
    if (!insightsOriginCountry) return [];
    return cities.filter((entry) => entry.country === insightsOriginCountry.name).slice(0, 240);
  }, [cities, insightsOriginCountry]);

  const insightsOriginCityOptions = useMemo<MultiSelectOption[]>(() => {
    const cityMap = new Map<string, Set<string>>();
    insightsOriginCities.forEach((entry) => {
      const city = entry.city.trim();
      if (!city) return;
      if (!cityMap.has(city)) {
        cityMap.set(city, new Set());
      }
      if (entry.iata) {
        cityMap.get(city)?.add(entry.iata);
      }
    });
    const options = Array.from(cityMap.entries()).map(([city, codes]) => {
      const codesList = Array.from(codes).sort();
      return {
        value: city,
        label: city,
        hint: codesList.length ? codesList.join(", ") : undefined,
        group: city ? city[0].toUpperCase() : "Cities"
      };
    });
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [insightsOriginCities]);

  const insightsOriginCitySet = useMemo(
    () => new Set(insightsOriginCityOptions.map((option) => option.value)),
    [insightsOriginCityOptions]
  );

  const originLabel = useMemo(() => {
    if (insightsOriginCity) {
      return insightsOriginCountry ? `${insightsOriginCity}, ${insightsOriginCountry.name}` : insightsOriginCity;
    }
    return insightsOriginCountry?.name ?? "Origin";
  }, [insightsOriginCity, insightsOriginCountry]);

  const insightCountryList = useMemo<CountryIdentity[]>(() => {
    const unique = new Map<string, CountryIdentity>();
    insightsCountries.forEach((value) => {
      const match = countryByValue.get(value);
      if (match) {
        if (!unique.has(match.name)) {
          unique.set(match.name, { name: match.name, code: match.code });
        }
      } else if (value && !unique.has(value)) {
        unique.set(value, { name: value, code: null });
      }
    });
    return Array.from(unique.values());
  }, [insightsCountries, countryByValue]);

  const tripRange = useMemo(() => {
    if (!departStart || !returnStart || !departEnd || !returnEnd) {
      return { minDays: 0, maxDays: 0 };
    }
    const minDays = daysBetween(departStart, returnStart);
    const maxDays = Math.max(minDays, daysBetween(departEnd, returnEnd));
    return { minDays, maxDays };
  }, [departStart, returnStart, departEnd, returnEnd]);

  const itineraryCategories = useMemo(
    () =>
      buildChaslesItineraries({
        destinations: insightCountryList,
        minDays: tripRange.minDays,
        maxDays: tripRange.maxDays
      }),
    [insightCountryList, tripRange.minDays, tripRange.maxDays]
  );

  const tripRangeLabel = useMemo(() => {
    if (!tripRange.minDays) return "--";
    return tripRange.minDays === tripRange.maxDays
      ? `${tripRange.minDays} days`
      : `${tripRange.minDays}-${tripRange.maxDays} days`;
  }, [tripRange.minDays, tripRange.maxDays]);

  const departWindowDays = useMemo(() => countDaysInclusive(departStart, departEnd), [departStart, departEnd]);
  const returnWindowDays = useMemo(() => countDaysInclusive(returnStart, returnEnd), [returnStart, returnEnd]);
  const datePairCount = useMemo(
    () => (departWindowDays > 0 && returnWindowDays > 0 ? departWindowDays * returnWindowDays : 0),
    [departWindowDays, returnWindowDays]
  );

  const insightsFingerprint = useMemo(() => {
    const sortedCountries = [...insightsCountries].sort();
    return JSON.stringify({
      origin_country: insightsOriginCountry?.code ?? insightsOriginCountry?.name ?? null,
      origin_city: insightsOriginCity || null,
      destination_countries: sortedCountries,
      depart_start: departStart,
      depart_end: departEnd,
      return_start: returnStart,
      return_end: returnEnd,
      currency: formatConfig.currency
    });
  }, [
    insightsCountries,
    insightsOriginCountry,
    insightsOriginCity,
    departStart,
    departEnd,
    returnStart,
    returnEnd,
    formatConfig.currency
  ]);

  const isLargeScan = useMemo(() => datePairCount > LARGE_SCAN_THRESHOLD, [datePairCount]);

  const activeInsightsJob = useMemo(() => {
    if (!lastInsightsJobId) return null;
    const match = jobs.find((job) => job.id === lastInsightsJobId);
    if (!match) return null;
    if (match.status === "queued" || match.status === "running") return match;
    return null;
  }, [jobs, lastInsightsJobId]);

  const hasSameActiveInsightsJob = useMemo(() => {
    if (!lastInsightsFingerprint || lastInsightsFingerprint !== insightsFingerprint) return false;
    if (activeInsightsJob) return true;
    return !!activeJobId && activeJobId === lastInsightsJobId;
  }, [activeInsightsJob, activeJobId, lastInsightsFingerprint, lastInsightsJobId, insightsFingerprint]);

  useEffect(() => {
    if (!isLargeScan) {
      setConfirmLargeScan(false);
    }
  }, [isLargeScan]);

  useEffect(() => {
    setConfirmRerun(false);
  }, [insightsFingerprint]);

  const hasActiveJobs = useMemo(
    () => jobs.some((job) => job.status === "queued" || job.status === "running"),
    [jobs]
  );

  const departRange = useMemo(() => toDateRange(departStart, departEnd), [departStart, departEnd]);
  const returnRange = useMemo(() => toDateRange(returnStart, returnEnd), [returnStart, returnEnd]);

  const formatDateValue = (value: string) => formatDate(value, formatConfig);
  const formatDateTimeValue = (value: string | null) => formatDateTime(value, formatConfig);
  const formatJobTimeValue = (value?: number | null) => formatJobTimestamp(value, formatConfig);
  const formatCurrencyValue = (value: number | null, currency?: string) =>
    formatCurrency(value, formatConfig, currency);
  const formatMonthsValue = (months?: number[] | null) => formatMonths(months, formatConfig);
  const restRange = (period: RestPeriod) => `${formatDateValue(period.start_date)} - ${formatDateValue(period.end_date)}`;
  const highlightLabel = (flight: FlightOption | null, metric: string) => {
    if (!flight) return { route: "--", metric, date: "" };
    return {
      route: `${flight.origin_iata} → ${flight.destination_iata}`,
      metric,
      date: `${formatDateValue(flight.depart_date)}${
        flight.return_date ? ` - ${formatDateValue(flight.return_date)}` : ""
      }`
    };
  };

  const filteredDestinations = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    let result = data.destinations;
    if (query) {
      result = result.filter((dest) => {
        const bucket = [dest.country, ...dest.cities, ...dest.destination_iatas, ...dest.source_iata]
          .join(" ")
          .toLowerCase();
        return bucket.includes(query);
      });
    }
    if (destMinDays > 0) {
      result = result.filter((dest) => dest.rest_period.days >= destMinDays);
    }
    if (destHaulFilter !== "all") {
      result = result.filter((dest) => (dest.haul_category ?? "unknown") === destHaulFilter);
    }

    const sorted = [...result];
    switch (destSort) {
      case "rest-asc":
        sorted.sort((a, b) => a.rest_period.days - b.rest_period.days);
        break;
      case "flight-hours":
        sorted.sort((a, b) => (a.flight_hours ?? Infinity) - (b.flight_hours ?? Infinity));
        break;
      case "country":
        sorted.sort((a, b) => a.country.localeCompare(b.country));
        break;
      default:
        sorted.sort((a, b) => b.rest_period.days - a.rest_period.days);
    }
    return sorted;
  }, [data, search, destMinDays, destHaulFilter, destSort]);

  const topFlights = useMemo(() => (data ? selectTopFlights(data.flights) : []), [data]);

  const flightHighlights = useMemo(() => {
    if (!data || !data.flights.length) return null;
    const withPrice = data.flights.filter((flight) => flight.price !== null);
    const withDuration = data.flights.filter((flight) => flight.total_duration_min !== null);
    const withStops = data.flights.filter((flight) => flight.stops !== null);
    const withScore = data.flights.filter((flight) => flight.score !== null);

    const cheapest = [...withPrice].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0] ?? null;
    const fastest =
      [...withDuration].sort((a, b) => (a.total_duration_min ?? Infinity) - (b.total_duration_min ?? Infinity))[0] ??
      null;
    const fewestStops = [...withStops].sort((a, b) => (a.stops ?? Infinity) - (b.stops ?? Infinity))[0] ?? null;
    const bestScore = [...withScore].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;

    return {
      cheapest,
      fastest,
      fewestStops,
      bestScore
    };
  }, [data]);

  const fewestStopsMetric =
    flightHighlights && typeof flightHighlights.fewestStops?.stops === "number"
      ? `${flightHighlights.fewestStops.stops} stops`
      : "--";
  const bestScoreMetric =
    flightHighlights && typeof flightHighlights.bestScore?.score === "number"
      ? `${flightHighlights.bestScore.score.toFixed(1)} score`
      : "--";

  const periodDetails = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { period: RestPeriod; countries: string[] }>();
    data.timeoff.rest_periods.forEach((period) => {
      map.set(makePeriodKey(period), { period, countries: [] });
    });
    data.destinations.forEach((dest) => {
      const key = makePeriodKey(dest.rest_period);
      const entry = map.get(key);
      if (!entry) return;
      if (!entry.countries.includes(dest.country)) {
        entry.countries.push(dest.country);
      }
    });
    return Array.from(map.values()).map((entry) => ({
      ...entry,
      countries: entry.countries.sort()
    }));
  }, [data]);

  const activePeriodKey = hoveredPeriodKey ?? selectedPeriodKey;
  const activePeriod = periodDetails.find((entry) => makePeriodKey(entry.period) === activePeriodKey) ?? null;
  const periodStats = useMemo(() => {
    if (!data?.timeoff.day_map) return new Map<string, { leave: number; holiday: number; weekend: number; closure: number }>();
    const dayMap = new Map(data.timeoff.day_map.map((day) => [day.date, day]));
    const stats = new Map<string, { leave: number; holiday: number; weekend: number; closure: number }>();

    const countForPeriod = (period: RestPeriod) => {
      const counts = { leave: 0, holiday: 0, weekend: 0, closure: 0 };
      const cursor = parseISODate(period.start_date);
      const end = parseISODate(period.end_date);
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10);
        const info = dayMap.get(key);
        if (info) {
          if (info.leave !== "NONE") counts.leave += 1;
          if (info.base_kind === "HOLIDAY") counts.holiday += 1;
          if (info.base_kind === "WEEKEND") counts.weekend += 1;
          if (info.base_kind === "CLOSURE") counts.closure += 1;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      return counts;
    };

    data.timeoff.rest_periods.forEach((period) => {
      stats.set(makePeriodKey(period), countForPeriod(period));
    });
    return stats;
  }, [data]);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result as string) as PipelineResult;
        setData(payload);
        setSource(file.name);
        setError(null);
        setLastPipelineRun(new Date().toISOString());
        setSelectedPeriodKey(null);
        setHoveredPeriodKey(null);
        if (payload.meta) {
          setFormatConfig((current) => ({
            locale: payload.meta?.locale ?? current.locale,
            timeZone: payload.meta?.timezone ?? current.timeZone,
            currency: payload.meta?.currency ?? current.currency
          }));
        }
      } catch (err) {
        setError("Invalid JSON file.");
      }
    };
    reader.readAsText(file);
  };

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    handleFile(file);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleClear = () => {
    setData(null);
    setSource("No data loaded");
    setError(null);
    setSelectedPeriodKey(null);
    setHoveredPeriodKey(null);
  };

  const handleExport = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pipeline_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportICS = () => {
    if (!data?.timeoff.day_map) return;
    const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Travel Optimizer//EN"];
    const pushEvent = (summary: string, start: string, end: string, description?: string) => {
      const uid = `${summary}-${start}-${end}-${Math.random().toString(36).slice(2)}@travel-optimizer`;
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${escapeICS(uid)}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`SUMMARY:${escapeICS(summary)}`);
      lines.push(`DTSTART;VALUE=DATE:${toICSDate(start)}`);
      lines.push(`DTEND;VALUE=DATE:${toICSDate(end)}`);
      if (description) {
        lines.push(`DESCRIPTION:${escapeICS(description)}`);
      }
      lines.push("END:VEVENT");
    };

    data.timeoff.rest_periods.forEach((period) => {
      pushEvent("Rest window", period.start_date, addDays(period.end_date, 1), "Optimized rest window");
    });

    data.timeoff.day_map.forEach((day) => {
      if (day.leave && day.leave !== "NONE") {
        const summary = day.reason ? day.reason : "Optimized leave";
        pushEvent(summary, day.date, addDays(day.date, 1));
        return;
      }
      if (day.base_kind === "HOLIDAY") {
        const summary = day.holiday_name ? `Holiday: ${day.holiday_name}` : "Holiday";
        pushEvent(summary, day.date, addDays(day.date, 1));
      }
    });

    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `travel_optimizer_${new Date().getFullYear()}.ics`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleResetFilters = () => {
    setPreferredCities([]);
    setPreferredCountries([]);
    setHaulTypes(["short", "medium", "long"]);
  };

  const handleDepartSelect = (range: DateRange | undefined) => {
    if (!range?.from) return;
    const startValue = toDateInputValue(range.from);
    if (range.to) {
      setDepartStart(startValue);
      setDepartEnd(toDateInputValue(range.to));
      return;
    }
    const currentEnd = parseISODate(departEnd);
    if (!Number.isNaN(currentEnd.getTime()) && currentEnd >= range.from) {
      setDepartStart(startValue);
      return;
    }
    setDepartStart(startValue);
    setDepartEnd(startValue);
  };

  const handleReturnSelect = (range: DateRange | undefined) => {
    if (!range?.from) return;
    const startValue = toDateInputValue(range.from);
    if (range.to) {
      setReturnStart(startValue);
      setReturnEnd(toDateInputValue(range.to));
      return;
    }
    const currentEnd = parseISODate(returnEnd);
    if (!Number.isNaN(currentEnd.getTime()) && currentEnd >= range.from) {
      setReturnStart(startValue);
      return;
    }
    setReturnStart(startValue);
    setReturnEnd(startValue);
  };

  const handleUsePeriodForInsights = (period: RestPeriod, countries: string[]) => {
    setDepartStart(period.start_date);
    setDepartEnd(period.start_date);
    setReturnStart(period.end_date);
    setReturnEnd(period.end_date);
    setInsightsCountries(Array.from(new Set(countries)));
    setTab("insights");
  };

  const parseApiError = async (response: Response) => {
    const text = await response.text();
    if (!text) return response.statusText;
    try {
      const payload = JSON.parse(text) as { detail?: string };
      return payload.detail ?? text;
    } catch {
      return text;
    }
  };

  const refreshJobs = async (showLoading = false) => {
    if (showLoading) setJobsLoading(true);
    setJobsError(null);
    try {
      const response = await fetch("/api/jobs");
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const payload = (await response.json()) as { items?: JobInfo[] };
      const items = payload.items ?? [];
      setJobs(items);
      if (activeJobId) {
        const activeJob = items.find((job) => job.id === activeJobId);
        if (activeJob && !["queued", "running"].includes(activeJob.status)) {
          setActiveJobId(null);
        }
      }
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Unable to fetch job queue.");
    } finally {
      if (showLoading) setJobsLoading(false);
    }
  };

  useEffect(() => {
    const shouldPoll = tab === "queue" || hasActiveJobs || !!activeJobId;
    if (!shouldPoll) return;
    let active = true;
    const poll = async () => {
      if (!active) return;
      await refreshJobs(false);
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [tab, hasActiveJobs, activeJobId]);

  const handleRun = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setApiError(null);
    if (running) return;
    if (apiStatus === "offline") {
      setApiError("API is offline. Start the backend before running the optimizer.");
      return;
    }
    if (!Number.isFinite(year) || year < 1900 || year > 2100) {
      setApiError("Enter a valid year between 1900 and 2100.");
      return;
    }
    if (!Number.isFinite(leaveDays) || leaveDays < 0 || leaveDays > 365) {
      setApiError("Leave days must be between 0 and 365.");
      return;
    }
    if (!Number.isFinite(minRest) || minRest < 1 || minRest > 60) {
      setApiError("Minimum rest window must be between 1 and 60 days.");
      return;
    }
    if (!homeCountry) {
      setApiError("Select a country of residence before running the optimizer.");
      return;
    }
    if (!homeCountry.code) {
      setApiError("Selected country is missing a valid code.");
      return;
    }
    const homeCityValue = homeCity.trim();
    if (homeCityValue && !homeCitySet.has(homeCityValue)) {
      setApiError("Select a home city from the list or clear the field.");
      return;
    }

    setRunning(true);

    const payload = {
      year,
      leave_days: leaveDays,
      country_code: homeCountry.code,
      min_rest: minRest,
      home_city: homeCityValue || null,
      preferred_cities: preferredCities.map(formatCityValue),
      preferred_countries: preferredCountries,
      haul_types: haulTypes,
      max_destinations: 10,
      max_flights_per_destination: 5,
      max_lodging_per_destination: 5,
      include_flights: !fastMode,
      currency: formatConfig.currency
    };

    try {
      const response = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const result = (await response.json()) as PipelineResult;
      setData(result);
      setSource("Live API");
      setError(null);
      setLastPipelineRun(new Date().toISOString());
      setSelectedPeriodKey(null);
      setHoveredPeriodKey(null);
      if (result.meta) {
        setFormatConfig((current) => ({
          locale: result.meta?.locale ?? current.locale,
          timeZone: result.meta?.timezone ?? current.timeZone,
          currency: result.meta?.currency ?? current.currency
        }));
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Unable to run optimizer.");
    } finally {
      setRunning(false);
    }
  };

  const handleInsights = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!insightsOriginCountry) {
      setInsightsError("Select an origin country before running flight insights.");
      return;
    }
    if (!insightsCountries.length) {
      setInsightsError("Select at least one destination country.");
      return;
    }
    const originCityValue = insightsOriginCity.trim();
    if (originCityValue && !insightsOriginCitySet.has(originCityValue)) {
      setInsightsError("Select an origin city from the list or clear the field.");
      return;
    }
    const departStartDate = parseISODate(departStart);
    const departEndDate = parseISODate(departEnd);
    const returnStartDate = parseISODate(returnStart);
    const returnEndDate = parseISODate(returnEnd);
    if (departStartDate > departEndDate) {
      setInsightsError("Departure window start must be before the end date.");
      return;
    }
    if (returnStartDate > returnEndDate) {
      setInsightsError("Return window start must be before the end date.");
      return;
    }
    if (returnStartDate < departStartDate) {
      setInsightsError("Return window must start on or after the departure window.");
      return;
    }
    if (isLargeScan && !confirmLargeScan) {
      setInsightsError(`This scan includes ${datePairCount} date combinations. Confirm to proceed.`);
      return;
    }
    if (hasSameActiveInsightsJob && !confirmRerun) {
      setInsightsError("An identical scan is already running. Confirm to re-run anyway.");
      return;
    }
    setInsightsLoading(true);
    setInsightsError(null);

    const payload = {
      origin_country_code: insightsOriginCountry.code ?? insightsOriginCountry.name,
      origin_city: originCityValue || null,
      destination_countries: insightsCountries,
      depart_start: departStart,
      depart_end: departEnd,
      return_start: returnStart,
      return_end: returnEnd,
      currency: formatConfig.currency
    };

    try {
      const response = await fetch("/api/jobs/flight-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const result = (await response.json()) as JobInfo;
      setActiveJobId(result.id);
      setLastInsightsFingerprint(insightsFingerprint);
      setLastInsightsJobId(result.id);
      setTab("queue");
      await refreshJobs(true);
    } catch (err) {
      setInsightsError(err instanceof Error ? err.message : "Unable to queue flight insights.");
    } finally {
      setInsightsLoading(false);
    }
  };

  const handleLoadJobResult = async (jobId: string) => {
    setJobsError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const payload = (await response.json()) as JobDetail;
      if (payload.result) {
        setInsights(payload.result);
        setLastInsightsRun(new Date().toISOString());
        setTab("insights");
        if (payload.result.meta) {
          setFormatConfig((current) => ({
            locale: payload.result?.meta?.locale ?? current.locale,
            timeZone: payload.result?.meta?.timezone ?? current.timeZone,
            currency: payload.result?.meta?.currency ?? current.currency
          }));
        }
      }
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Unable to load job results.");
    }
  };

  const handleCancelJob = async (jobId: string) => {
    setJobsError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      await refreshJobs(false);
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Unable to cancel job.");
    }
  };

  const getDestinationLabel = (destination: DestinationSuggestion | null) => {
    if (!destination) return "Pending";
    const flag = flagEmoji(destination.country_code ?? countryCodeByName.get(destination.country));
    const cities = destination.cities.length ? destination.cities.join(", ") : "General";
    return `${flag ? `${flag} ` : ""}${destination.country} · ${cities}`;
  };

  const renderFlightInsightCard = (title: string, options: FlightInsightsResult["top_price"]) => (
    <div className="insight-card">
      <div className="insight-header">
        <h4>{title}</h4>
        <span className="chip">Top {options.length}</span>
      </div>
      <div className="insight-list">
        {options.length ? (
          options.map((option, index) => {
            const durationLabel = option.duration ? option.duration : formatDuration(option.total_duration_min);
            const carrierLabel = option.flight_name ? `Carrier: ${option.flight_name}` : "Carrier: --";
            const timeLabel =
              option.departure_time && option.arrival_time
                ? `${option.departure_time} → ${option.arrival_time}${option.arrival_time_ahead ? ` (${option.arrival_time_ahead})` : ""}`
                : "Times: --";
            const routeLabel = (option.itinerary_route ?? option.segment_route_group ?? "--").replace(/>/g, " → ");
            const tripLabel = option.trip_type ? option.trip_type.replace("-", " ") : "trip";
            return (
              <div key={`${option.origin_iata}-${option.destination_iata}-${index}`} className="insight-row">
                <div>
                  <strong>
                    {option.origin_iata} → {option.destination_iata}
                  </strong>
                  <p className="muted">
                    {formatDateValue(option.depart_date)} ·{" "}
                    {option.return_date ? formatDateValue(option.return_date) : "One-way"}
                  </p>
                  <p className="insight-sub">{carrierLabel}</p>
                  <p className="insight-sub">{timeLabel}</p>
                  <p className="insight-meta">
                    {tripLabel} · {routeLabel}
                  </p>
                </div>
                <div className="insight-metrics">
                  <span>{formatCurrencyValue(option.price, insights?.summary.currency)}</span>
                  <span>{durationLabel}</span>
                  <span>{option.stops ?? "--"} stops</span>
                </div>
              </div>
            );
          })
        ) : (
          <p className="muted">No options available.</p>
        )}
      </div>
    </div>
  );

  const renderHighlightCard = (title: string, flight: FlightOption | null, metric: string) => {
    const highlight = highlightLabel(flight, metric);
    return (
      <div className="highlight-card">
        <p className="muted">{title}</p>
        <h4>{highlight.route}</h4>
        <span className="highlight-metric">{highlight.metric}</span>
        {highlight.date && <span className="highlight-date">{highlight.date}</span>}
      </div>
    );
  };

  const apiLabel = apiStatus === "online" ? "API online" : apiStatus === "offline" ? "API offline" : "API checking";
  const originFlag = flagEmoji(insightsOriginCountry?.code);
  const hasItineraryInputs = insightCountryList.length > 0 && tripRange.minDays > 0;
  const insightsReport = insights?.artifacts?.report_excel;

  return (
    <div className="app">
      <div className="app-glow" />
      <header className="hero" data-animate>
        <div className="hero-top">
          <div>
            <p className="eyebrow">Travel Optimizer</p>
            <h1>Precision travel planning, distilled.</h1>
            <p className="subtitle">
              Two distinct modules: a leave-based destination advisor and a date-range flight insights scanner.
            </p>
          </div>
          <div className="source-card">
            {tab === "optimizer" ? (
              <>
                <span className="source-label">Loaded</span>
                <span className="source-value">{source}</span>
                <div className="status-row">
                  <span className={`status-pill ${apiStatus}`}>
                    <span className="status-dot" />
                    {apiLabel}
                  </span>
                  <span className="status-meta">Last run {formatDateTimeValue(lastPipelineRun)}</span>
                </div>
                {data ? (
                  <div className="source-meta">
                    <span>{data.destinations.length} destinations</span>
                    <span>{data.flights.length} flights</span>
                    <span>{data.itineraries.length} itineraries</span>
                  </div>
                ) : (
                  <span className="source-hint">Run the optimizer to generate results.</span>
                )}
              </>
            ) : tab === "insights" ? (
              <>
                <span className="source-label">Insights</span>
                <span className="source-value">{insights ? "Latest scan ready" : "No scan yet"}</span>
                <div className="status-row">
                  <span className={`status-pill ${apiStatus}`}>
                    <span className="status-dot" />
                    {apiLabel}
                  </span>
                  <span className="status-meta">Last scan {formatDateTimeValue(lastInsightsRun)}</span>
                </div>
                {insights ? (
                  <div className="source-meta">
                    <span>{insights.summary.options} options</span>
                    <span>{insights.summary.origin_airports.join(", ") || "--"} origin</span>
                    <span>{insights.summary.destination_airports.length} destinations</span>
                  </div>
                ) : (
                  <span className="source-hint">Run a flight insights scan to populate this view.</span>
                )}
              </>
            ) : (
              <>
                <span className="source-label">Queue</span>
                <span className="source-value">{jobs.length ? `${jobs.length} jobs` : "No jobs yet"}</span>
                <div className="status-row">
                  <span className={`status-pill ${apiStatus}`}>
                    <span className="status-dot" />
                    {apiLabel}
                  </span>
                  <span className="status-meta">{hasActiveJobs ? "Active jobs running" : "Queue idle"}</span>
                </div>
                {activeJobId ? (
                  <span className="source-hint">Tracking job {activeJobId}</span>
                ) : (
                  <span className="source-hint">Run flight insights to queue a job.</span>
                )}
              </>
            )}
          </div>
        </div>
        {tab === "optimizer" && (
          <div className="controls" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
            <label className="upload">
              <input type="file" accept="application/json" onChange={handleFileInput} />
              <span>Upload JSON</span>
            </label>
            <button className="ghost" type="button" onClick={handleClear}>
              Clear
            </button>
            <button className="ghost" type="button" onClick={handleExport} disabled={!data}>
              Download JSON
            </button>
            {error && <span className="error">{error}</span>}
          </div>
        )}
      </header>

      <section className="section control-panel" data-animate>
        <div className="section-header">
          <div>
            <p className="eyebrow">Mission control</p>
            <h2>Choose the right module</h2>
          </div>
        </div>
        <div className="module-grid">
          <button
            type="button"
            className={`module-card ${tab === "optimizer" ? "active" : ""}`}
            onClick={() => setTab("optimizer")}
          >
            <div className="module-card-header">
              <span className="module-badge">Module 1</span>
              <span className="module-tag">Leave-based destinations</span>
            </div>
            <h3>Advisor: optimized leave → countries & cities</h3>
            <p className="muted">
              Inputs: year, leave days, home country/city, and minimum rest. Outputs: optimized calendar plus destination
              recommendations.
            </p>
          </button>
          <button
            type="button"
            className={`module-card ${tab === "insights" ? "active" : ""}`}
            onClick={() => setTab("insights")}
          >
            <div className="module-card-header">
              <span className="module-badge">Module 2</span>
              <span className="module-tag">Date-range flight insights</span>
            </div>
            <h3>Flight stats: depart/return windows → top results</h3>
            <p className="muted">
              Inputs: origin country/city, destination countries, departure and return windows. Outputs: top 3 flights by
              price, duration, stops, and score.
            </p>
          </button>
        </div>
        {optionsError && <p className="error">{optionsError}</p>}
        {tab === "optimizer" ? (
          <form className="panel-grid" onSubmit={handleRun}>
            <div className="panel-card">
              <h3>Leave setup</h3>
              <p className="muted">
                This module suggests destinations based on your leave days, year, and home location.
              </p>
              <div className="field">
                <label>Year</label>
                <Input
                  type="number"
                  min={2000}
                  value={year}
                  onChange={(event) => setYear(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label>Leave days</label>
                <Input
                  type="number"
                  min={0}
                  value={leaveDays}
                  onChange={(event) => setLeaveDays(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label>Minimum rest window</label>
                <Input
                  type="number"
                  min={1}
                  value={minRest}
                  onChange={(event) => setMinRest(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label>Country of residence</label>
                <OriginCountryPicker
                  options={originCountryOptions}
                  value={homeCountry?.name ?? null}
                  onChange={(nextValue) => {
                    const match = nextValue ? countries.find((country) => country.name === nextValue) ?? null : null;
                    setHomeCountry(match);
                    setHomeCity("");
                  }}
                  placeholder="Select a country"
                  emptyMessage="No countries found"
                  title="Country of residence"
                  subtitle="Sets the holiday calendar and home base."
                  badgeFallback="Residence"
                  searchPlaceholder="Search countries"
                />
              </div>
              <div className="field">
                <label>Home city</label>
                <OriginCityPicker
                  options={homeCityPickerOptions}
                  value={homeCity || null}
                  onChange={(nextValue) => setHomeCity(nextValue ?? "")}
                  placeholder={homeCountry ? "Select a home city" : "Select a country first"}
                  emptyMessage={homeCountry ? "No cities found" : "Select a country first"}
                  disabled={!homeCountry}
                  title="Home city"
                  subtitle="Used to match nearby airports."
                  badgeFallback="City"
                  searchPlaceholder="Search cities"
                />
              </div>
            </div>

            <div className="panel-card">
              <h3>Destination filters</h3>
              <div className="field">
                <label>Preferred cities</label>
                <DestinationCountryPicker
                  options={cityOptions}
                  selected={preferredCities}
                  onChange={setPreferredCities}
                  placeholder="Select preferred cities"
                  emptyMessage="No cities found"
                  title="Preferred cities"
                  subtitle="Search and pin cities you want to prioritize."
                  searchPlaceholder="Search cities"
                  emptyState="No preferred cities selected yet."
                  maxVisible={200}
                />
              </div>
              <div className="field">
                <label>Preferred countries</label>
                <DestinationCountryPicker
                  options={preferredCountryOptions}
                  selected={preferredCountries}
                  onChange={setPreferredCountries}
                  placeholder="Select preferred countries"
                  emptyMessage="No countries found"
                  title="Preferred countries"
                  subtitle="Focus recommendations on these countries."
                  searchPlaceholder="Search countries"
                  emptyState="No preferred countries selected yet."
                />
              </div>
              <div className="field">
                <label>Haul types</label>
                <div className="toggle-group">
                  {haulOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`toggle ${haulTypes.includes(option.value) ? "active" : ""}`}
                      onClick={() => {
                        if (haulTypes.includes(option.value)) {
                          setHaulTypes(haulTypes.filter((value) => value !== option.value));
                        } else {
                          setHaulTypes([...haulTypes, option.value]);
                        }
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <button className="ghost" type="button" onClick={handleResetFilters}>
                Reset filters
              </button>
            </div>

            <div className="panel-card">
              <h3>Run optimizer</h3>
              <p className="muted">
                The optimizer will compute the best leave windows and refresh destinations based on your filters.
              </p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={fastMode}
                  onChange={(event) => setFastMode(event.target.checked)}
                />
                Fast mode (skip flight search)
              </label>
              <span className="helper-text">Flight search can take several minutes; use insights when ready.</span>
              <button className="primary" type="submit" disabled={running}>
                {running ? "Running..." : "Launch optimization"}
              </button>
              {apiError && <p className="error">{apiError}</p>}
            </div>
          </form>
        ) : tab === "insights" ? (
          <form className="panel-grid" onSubmit={handleInsights}>
            <div className="panel-card">
              <h3>Origin and dates</h3>
              <div className="field">
                <label>Origin country</label>
                <OriginCountryPicker
                  options={originCountryOptions}
                  value={insightsOriginCountry?.name ?? null}
                  onChange={(nextValue) => {
                    const match = nextValue ? countries.find((country) => country.name === nextValue) ?? null : null;
                    setInsightsOriginCountry(match);
                    setInsightsOriginCity("");
                  }}
                  placeholder="Select a country"
                  emptyMessage="No countries found"
                />
              </div>
              <div className="field">
                <label>Origin city</label>
                <OriginCityPicker
                  options={insightsOriginCityOptions}
                  value={insightsOriginCity || null}
                  onChange={(nextValue) => setInsightsOriginCity(nextValue ?? "")}
                  placeholder={insightsOriginCountry ? "Select origin city" : "Select origin country first"}
                  emptyMessage={insightsOriginCountry ? "No cities found" : "Select an origin country first"}
                  disabled={!insightsOriginCountry}
                />
              </div>
              <div className="date-panel">
                <div className="date-picker">
                  <div className="date-picker-header">
                    <div>
                      <label>Departure window</label>
                      <p className="muted">Pick a date range.</p>
                    </div>
                    <span className="chip">
                      {formatDateValue(departStart)} - {formatDateValue(departEnd)}
                    </span>
                  </div>
                  <DayPicker
                    mode="range"
                    selected={departRange}
                    onSelect={handleDepartSelect}
                    numberOfMonths={2}
                    weekStartsOn={1}
                    showOutsideDays
                    fixedWeeks
                    defaultMonth={departRange?.from ?? new Date()}
                  />
                </div>
                <div className="date-picker">
                  <div className="date-picker-header">
                    <div>
                      <label>Return window</label>
                      <p className="muted">Pick a return date range.</p>
                    </div>
                    <span className="chip">
                      {formatDateValue(returnStart)} - {formatDateValue(returnEnd)}
                    </span>
                  </div>
                  <DayPicker
                    mode="range"
                    selected={returnRange}
                    onSelect={handleReturnSelect}
                    numberOfMonths={2}
                    weekStartsOn={1}
                    showOutsideDays
                    fixedWeeks
                    defaultMonth={returnRange?.from ?? new Date()}
                  />
                </div>
              </div>
            </div>

            <div className="panel-card">
              <h3>Destination countries</h3>
              <div className="field">
                <label>Target countries</label>
                <DestinationCountryPicker
                  options={insightsCountryOptions}
                  selected={insightsCountries}
                  onChange={setInsightsCountries}
                  placeholder="Select destination countries"
                  emptyMessage="No countries found"
                />
              </div>
            </div>

            <div className="panel-card">
              <h3>Run insights</h3>
              <p className="muted">
                This module scans flights across your date windows and aggregates the best prices, fastest routes, and
                lowest stop counts.
              </p>
              {isLargeScan && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmLargeScan}
                    onChange={(event) => setConfirmLargeScan(event.target.checked)}
                  />
                  I understand this scan covers {datePairCount} date combinations and may take longer.
                </label>
              )}
              {hasSameActiveInsightsJob && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmRerun}
                    onChange={(event) => setConfirmRerun(event.target.checked)}
                  />
                  Re-run even though the same scan is currently running.
                </label>
              )}
              <button className="primary" type="submit" disabled={insightsLoading}>
                {insightsLoading ? "Scanning..." : "Run flight insights"}
              </button>
              <span className="helper-text">Jobs run in the background. Track progress in the queue tab.</span>
              <div className="insight-plan">
                <div className="plan-row">
                  <span className="plan-label">Origin</span>
                  <span>{originLabel}</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">Destination countries</span>
                  <span>{insightsCountries.length || 0} selected</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">Departure dates</span>
                  <span>{departWindowDays} days</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">Return dates</span>
                  <span>{returnWindowDays} days</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">Date combinations</span>
                  <span>{datePairCount} pairs</span>
                </div>
                <p className="muted">
                  We scan every origin airport × destination airport pair for each date combination. Results are cached
                  to avoid duplicates and the scanner runs in parallel.
                </p>
              </div>
              <span className="status-meta">Last run {formatDateTimeValue(lastInsightsRun)}</span>
              {insightsError && <p className="error">{insightsError}</p>}
            </div>
          </form>
        ) : (
          <div className="panel-grid">
            <div className="panel-card">
              <h3>Queue control</h3>
              <p className="muted">Track background flight scans and download results when they complete.</p>
              <div className="controls">
                <button className="ghost" type="button" onClick={() => refreshJobs(true)}>
                  {jobsLoading ? "Refreshing..." : "Refresh queue"}
                </button>
                <span className="status-meta">
                  {hasActiveJobs ? "Active jobs running" : "No active jobs"}
                </span>
              </div>
              {jobsError && <p className="error">{jobsError}</p>}
            </div>
            <div className="panel-card">
              <h3>What happens next?</h3>
              <p className="muted">
                Start a flight insight scan, then monitor progress here. You can cancel a job at any time and rerun with
                different dates or countries.
              </p>
              <div className="queue-steps">
                <span className="chip">1</span>
                <span>Load airports for origin + destinations</span>
                <span className="chip">2</span>
                <span>Build the full search matrix</span>
                <span className="chip">3</span>
                <span>Scan flights in parallel + cache</span>
                <span className="chip">4</span>
                <span>Clean + rank results</span>
              </div>
              {activeJobId && <span className="status-meta">Latest job ID {activeJobId}</span>}
            </div>
          </div>
        )}
      </section>

      {tab === "insights" && (
        <>
          <section className="section" data-animate>
            {insights ? (
              <>
                <div className="section-header">
                <div>
                  <p className="eyebrow">Flight insights</p>
                  <h2>Planner highlights</h2>
                </div>
                <div className="insight-actions">
                  <div className="pill">
                    {insights.summary.options} options - {insights.summary.origin_airports.join(", ")}
                  </div>
                  {insightsReport && (
                    <a className="ghost" href={insightsReport.url} download>
                      Download Excel
                    </a>
                  )}
                </div>
              </div>
                <div className="stats">
                  <div className="stat-card">
                    <p>Departure window</p>
                    <h3>
                      {formatDateValue(insights.summary.depart_start)} - {formatDateValue(insights.summary.depart_end)}
                    </h3>
                    <span>
                      Return {formatDateValue(insights.summary.return_start)} -{" "}
                      {formatDateValue(insights.summary.return_end)}
                    </span>
                  </div>
                  <div className="stat-card">
                    <p>Origin airports</p>
                    <h3>{insights.summary.origin_airports.join(", ")}</h3>
                    <span>Currency {insights.summary.currency}</span>
                  </div>
                  <div className="stat-card">
                    <p>Destination airports</p>
                    <h3>{insights.summary.destination_airports.slice(0, 6).join(", ")}</h3>
                    <span>{insights.summary.destination_airports.length} total airports</span>
                  </div>
                </div>
                <div className="insights-grid">
                  {renderFlightInsightCard("Best prices", insights.top_price)}
                  {renderFlightInsightCard("Fastest routes", insights.top_duration)}
                  {renderFlightInsightCard("Fewest stops", insights.top_fewest_stops)}
                  {renderFlightInsightCard("Top scores", insights.top_score)}
                </div>
              </>
            ) : (
              <div className="empty empty-compact">
                <h2>No insights yet</h2>
                <p>Run a scan to surface the best prices, fastest routes, and top scoring trips.</p>
              </div>
            )}
          </section>
          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Chasles itineraries</p>
                <h2>Suggested routing chains</h2>
              </div>
              <div className="pill">{tripRangeLabel}</div>
            </div>
            <p className="muted">
              Build multi-stop routes from your selected countries. Chasles relation keeps the chain coherent: A→B + B→C
              = A→C.
            </p>
            {hasItineraryInputs ? (
              itineraryCategories.length ? (
                <div className="itinerary-studio">
                  {itineraryCategories.map((category) => (
                    <div key={category.key} className="itinerary-category">
                      <div className="itinerary-category-header">
                        <div>
                          <h3>{category.label}</h3>
                          <p className="muted">{category.description}</p>
                        </div>
                        <span className="chip">{category.suggestions.length} routes</span>
                      </div>
                      <div className="itinerary-list">
                        {category.suggestions.map((suggestion) => {
                          const routeStops = [
                            { label: originLabel, flag: originFlag, kind: "origin" },
                            ...suggestion.stops.map((stop) => ({
                              label: stop.country.name,
                              flag: flagEmoji(stop.country.code),
                              kind: "stop"
                            })),
                            { label: originLabel, flag: originFlag, kind: "origin" }
                          ];

                          return (
                            <div key={suggestion.id} className="itinerary-suggestion">
                              <div className="itinerary-route">
                                {routeStops.map((stop, index) => (
                                  <div
                                    key={`${suggestion.id}-${stop.label}-${index}`}
                                    className="route-node"
                                  >
                                    <span className={`route-pill ${stop.kind}`}>
                                      {stop.flag && <span className="flag">{stop.flag}</span>}
                                      {stop.label}
                                    </span>
                                    {index < routeStops.length - 1 && <span className="route-arrow">→</span>}
                                  </div>
                                ))}
                              </div>
                              <div className="itinerary-stops">
                                {suggestion.stops.map((stop) => {
                                  const flag = flagEmoji(stop.country.code);
                                  return (
                                    <span key={`${suggestion.id}-${stop.country.name}`} className="stop-chip">
                                      {flag && <span className="flag">{flag}</span>}
                                      {stop.country.name} · {stop.days}d
                                    </span>
                                  );
                                })}
                                <span className="stop-chip travel-chip">{suggestion.travelDays} travel days</span>
                              </div>
                              <div className="itinerary-meta">
                                <span className="chip">~{suggestion.totalDays} days</span>
                                <span className="muted">Based on {tripRangeLabel} window</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty empty-compact">
                  <h2>No itineraries yet</h2>
                  <p>Add more destination countries to expand the route builder.</p>
                </div>
              )
            ) : (
              <div className="empty empty-compact">
                <h2>Pick destination countries</h2>
                <p>Select at least one country and set a date window to build itineraries.</p>
              </div>
            )}
          </section>
        </>
      )}

      {tab === "queue" && (
        <section className="section" data-animate>
          <div className="section-header">
            <div>
              <p className="eyebrow">Flight jobs</p>
              <h2>Progress and queue</h2>
            </div>
            <div className="pill">{jobs.length} jobs</div>
          </div>
          {jobs.length ? (
            <div className="queue-grid">
              {jobs.map((job) => (
                <div className="job-card" key={job.id}>
                  <div className="job-header">
                    <div>
                      <p className="eyebrow">{formatJobKind(job.kind)}</p>
                      <h3>{formatJobKind(job.kind)}</h3>
                    </div>
                    <span className={`status-badge status-${job.status}`}>{formatJobStatus(job.status)}</span>
                  </div>
                  <div className="job-meta">
                    <span>{Math.round(job.progress * 100)}%</span>
                    <span>Updated {formatJobTimeValue(job.updated_at)}</span>
                  </div>
                  <p className="job-stage">{job.stage}</p>
                  <div
                    className="progress-bar"
                    role="progressbar"
                    aria-valuenow={job.progress * 100}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Job progress"
                  >
                    <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                  </div>
                  {job.error && <p className="error">{job.error}</p>}
                  <div className="job-actions">
                    {(job.status === "running" || job.status === "queued") && (
                      <button className="ghost" type="button" onClick={() => handleCancelJob(job.id)}>
                        Cancel job
                      </button>
                    )}
                    {job.status === "completed" && (
                      <button className="primary" type="button" onClick={() => handleLoadJobResult(job.id)}>
                        Load results
                      </button>
                    )}
                  </div>
                  <span className="status-meta">Job ID {job.id}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty empty-compact">
              <h2>No jobs yet</h2>
              <p>Queue a flight insight scan to see progress and download results here.</p>
            </div>
          )}
        </section>
      )}

      {tab === "optimizer" &&
        (!data ? (
          <section className="empty" data-animate>
            <h2>No results yet</h2>
            <p>Run the optimizer to generate results before exploring the calendar, map, and destinations.</p>
          </section>
        ) : (
          <>
          <section className="stats" data-animate>
            <div className="stat-card">
              <p>Total rest days</p>
              <h3>{data.timeoff.total_rest_days}</h3>
              <span>Across {data.timeoff.rest_periods.length} windows</span>
            </div>
            <div className="stat-card">
              <p>Paid leave used</p>
              <h3>{data.timeoff.used_leave_days}</h3>
              <span>{data.timeoff.unused_leave_days} unused</span>
            </div>
            <div className="stat-card">
              <p>Optimization score</p>
              <h3>{data.timeoff.score.toFixed(1)}</h3>
              <span>Composite rest index</span>
            </div>
            <div className="stat-card accent">
              <p>Destinations</p>
              <h3>{data.destinations.length}</h3>
              <span>{data.flights.length} flight options</span>
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Optimized calendar</p>
                <h2>See every holiday and optimized leave day</h2>
              </div>
              <div className="calendar-actions">
                <div className="pill">{data.timeoff.rest_periods.length} rest windows</div>
                <button className="ghost" type="button" onClick={handleExportICS}>
                  Download calendar (.ics)
                </button>
              </div>
            </div>
            <div className="calendar-layout">
              <div className="calendar-stack">
                <TimeoffCalendar
                  days={data.timeoff.day_map}
                  restPeriods={data.timeoff.rest_periods}
                  activePeriodKey={activePeriodKey}
                  selectedPeriodKey={selectedPeriodKey}
                  onHover={setHoveredPeriodKey}
                  onSelect={setSelectedPeriodKey}
                  locale={formatConfig.locale}
                  timeZone={formatConfig.timeZone}
                />
                <div className="calendar-legend">
                  <div className="legend-item">
                    <span className="legend-swatch weekend" />
                    Weekend
                  </div>
                  <div className="legend-item">
                    <span className="legend-swatch holiday" />
                    Holiday
                  </div>
                  <div className="legend-item">
                    <span className="legend-swatch closure" />
                    Closure
                  </div>
                  <div className="legend-item">
                    <span className="legend-swatch leave" />
                    Optimized leave
                  </div>
                </div>
              </div>
              <div className="calendar-panel">
                <div className="calendar-panel-header">
                  <h3>Rest windows</h3>
                  <p className="muted">Hover or click a window to reveal destination suggestions.</p>
                </div>
                <div className="period-list" onMouseLeave={() => setHoveredPeriodKey(null)}>
                  {periodDetails.map((entry) => {
                    const key = makePeriodKey(entry.period);
                    const isActive = key === activePeriodKey;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`period-item ${isActive ? "active" : ""}`}
                        onMouseEnter={() => setHoveredPeriodKey(key)}
                        onClick={() => setSelectedPeriodKey(key)}
                      >
                        <span>{restRange(entry.period)}</span>
                        <span className="muted">{entry.period.days} days</span>
                      </button>
                    );
                  })}
                  {!periodDetails.length && <p className="muted">No rest windows generated yet.</p>}
                </div>
                {activePeriod ? (
                  <div className="period-detail">
                    <div>
                      <h4>{restRange(activePeriod.period)}</h4>
                      <p className="muted">{activePeriod.period.days} days of rest</p>
                    </div>
                    {periodStats.get(makePeriodKey(activePeriod.period)) && (
                      <div className="period-stats">
                        <span className="chip">
                          {periodStats.get(makePeriodKey(activePeriod.period))?.leave ?? 0} optimized leave
                        </span>
                        <span className="chip">
                          {periodStats.get(makePeriodKey(activePeriod.period))?.holiday ?? 0} holidays
                        </span>
                        <span className="chip">
                          {periodStats.get(makePeriodKey(activePeriod.period))?.weekend ?? 0} weekend days
                        </span>
                        <span className="chip">
                          {periodStats.get(makePeriodKey(activePeriod.period))?.closure ?? 0} closures
                        </span>
                      </div>
                    )}
                    <div className="period-countries">
                      {activePeriod.countries.length ? (
                        activePeriod.countries.map((country) => {
                          const code = countryCodeByName.get(country);
                          const flag = flagEmoji(code);
                          return (
                            <span key={country} className="country-chip">
                              {flag && <span className="flag">{flag}</span>}
                              {country}
                            </span>
                          );
                        })
                      ) : (
                        <span className="muted">No destination suggestions for this window.</span>
                      )}
                    </div>
                    <button
                      className="primary"
                      type="button"
                      onClick={() => handleUsePeriodForInsights(activePeriod.period, activePeriod.countries)}
                      disabled={!activePeriod.countries.length}
                    >
                      Use this window for flight insights
                    </button>
                  </div>
                ) : (
                  <div className="period-detail empty-detail">
                    <p className="muted">Hover a window on the calendar to preview destinations.</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Timeoff intelligence</p>
                <h2>Rest period map</h2>
              </div>
              {data.timeoff.best_month && (
                <div className="pill">
                  Best month #{data.timeoff.best_month.month} · {data.timeoff.best_month.efficiency.toFixed(2)} rest/CP
                </div>
              )}
            </div>
            <div className="rest-grid">
              {data.timeoff.rest_periods.map((period, index) => (
                <div key={`${period.start_date}-${index}`} className="rest-card">
                  <div>
                    <h4>{restRange(period)}</h4>
                    <p className="muted">{period.days} days</p>
                  </div>
                  <span className="chip">Window {index + 1}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Destinations</p>
                <h2>Shortlisted places</h2>
              </div>
              <div className="pill">{filteredDestinations.length} matches</div>
            </div>
            <div className="search-controls">
              <input
                placeholder="Search country, city, or IATA"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search destinations"
              />
              <select
                value={destHaulFilter}
                onChange={(event) => setDestHaulFilter(event.target.value)}
                aria-label="Filter by haul type"
              >
                <option value="all">All hauls</option>
                <option value="short">Short-haul</option>
                <option value="medium">Medium-haul</option>
                <option value="long">Long-haul</option>
                <option value="ultra">Ultra-long</option>
              </select>
              <select value={destSort} onChange={(event) => setDestSort(event.target.value)} aria-label="Sort results">
                <option value="rest-desc">Sort by rest days</option>
                <option value="rest-asc">Sort by rest days (asc)</option>
                <option value="flight-hours">Sort by flight hours</option>
                <option value="country">Sort by country</option>
              </select>
              <input
                type="number"
                min={0}
                value={destMinDays}
                onChange={(event) => setDestMinDays(Number(event.target.value))}
                placeholder="Min rest days"
                aria-label="Minimum rest days"
              />
            </div>
            <div className="dest-grid">
              {filteredDestinations.map((dest, index) => {
                const flag = flagEmoji(dest.country_code ?? countryCodeByName.get(dest.country));
                const climateMonths = formatMonthsValue(dest.climate?.months);
                return (
                  <div key={`${dest.country}-${index}`} className="dest-card">
                    <div className="dest-header">
                      <div>
                        <h4>
                          {flag && <span className="flag">{flag}</span>} {dest.country}
                        </h4>
                        <p className="muted">
                          {dest.haul_category ? `${dest.haul_category} haul` : "Haul not classified"}
                        </p>
                      </div>
                      {dest.flight_hours && <span className="chip">~{dest.flight_hours}h flight</span>}
                    </div>
                    <div className="dest-badges">
                      {dest.climate?.avg_temp_c !== undefined && dest.climate?.avg_temp_c !== null && (
                        <span
                          className="chip"
                          title={
                            climateMonths
                              ? `Avg temperature (${climateMonths}): ${dest.climate.avg_temp_c}C`
                              : `Avg temperature: ${dest.climate.avg_temp_c}C`
                          }
                        >
                          {dest.climate.avg_temp_c}C avg
                        </span>
                      )}
                      {dest.climate?.precip_mm !== undefined && dest.climate?.precip_mm !== null && (
                        <span
                          className="chip"
                          title={
                            climateMonths
                              ? `Avg precipitation (${climateMonths}): ${dest.climate.precip_mm}mm`
                              : `Avg precipitation: ${dest.climate.precip_mm}mm`
                          }
                        >
                          {dest.climate.precip_mm}mm rain
                        </span>
                      )}
                      {dest.safety?.level && (
                        <span
                          className={`chip safety ${safetyClass(dest.safety.level)}`}
                          title={dest.safety.message ?? "Safety advisory"}
                        >
                          Safety: {dest.safety.level}
                        </span>
                      )}
                    </div>
                    <div className="dest-cities">
                      {dest.cities.length ? (
                        dest.cities.map((city) => (
                          <span key={`${dest.country}-${city}`} className="city-chip">
                            {flag && <span className="flag">{flag}</span>}
                            <span>
                              {city}, {dest.country}
                            </span>
                          </span>
                        ))
                      ) : (
                        <span className="muted">General coverage</span>
                      )}
                    </div>
                    <div className="dest-meta">
                      <span className="pill">{restRange(dest.rest_period)}</span>
                      <span className="chip">From {dest.source_iata.join(", ")}</span>
                      <span className="chip">To {dest.destination_iatas.join(", ")}</span>
                    </div>
                  </div>
                );
              })}
              {!filteredDestinations.length && <p className="muted">No destinations match the filter.</p>}
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Network view</p>
                <h2>Routes map</h2>
              </div>
              <p className="muted">Visualize the strongest routes and their rest windows.</p>
            </div>
            <RoutesMap data={data} formatConfig={formatConfig} />
          </section>

          {flightHighlights && (
            <section className="section" data-animate>
              <div className="section-header">
                <div>
                  <p className="eyebrow">Flight highlights</p>
                  <h2>Best options at a glance</h2>
                </div>
                <p className="muted">Best price, fastest route, and strongest scores across results.</p>
              </div>
              <div className="highlight-grid">
                {renderHighlightCard(
                  "Best price",
                  flightHighlights.cheapest,
                  formatCurrencyValue(flightHighlights.cheapest?.price ?? null)
                )}
                {renderHighlightCard(
                  "Fastest",
                  flightHighlights.fastest,
                  formatDuration(flightHighlights.fastest?.total_duration_min ?? null)
                )}
                {renderHighlightCard(
                  "Fewest stops",
                  flightHighlights.fewestStops,
                  fewestStopsMetric
                )}
                {renderHighlightCard(
                  "Top score",
                  flightHighlights.bestScore,
                  bestScoreMetric
                )}
              </div>
            </section>
          )}

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Flights</p>
                <h2>Top flight options</h2>
              </div>
              <p className="muted">Showing best ranked options across destinations.</p>
            </div>
            <div className="flight-grid">
              {topFlights.map((flight, index) => (
                <div key={`${flight.origin_iata}-${flight.destination_iata}-${index}`} className="flight-card">
                  <div className="flight-header">
                    <h4>{getRouteLabel(flight)}</h4>
                    <span className="chip">{flight.provider}</span>
                  </div>
                  <div className="flight-meta">
                    <span>{formatDateValue(flight.depart_date)}</span>
                    <span>{flight.return_date ? formatDateValue(flight.return_date) : "One-way"}</span>
                  </div>
                  <div className="flight-details">
                    <div>
                      <p className="muted">Duration</p>
                      <strong>{formatDuration(flight.total_duration_min)}</strong>
                    </div>
                    <div>
                      <p className="muted">Stops</p>
                      <strong>{flight.stops ?? "--"}</strong>
                    </div>
                    <div>
                      <p className="muted">Price</p>
                      <strong>{formatCurrencyValue(flight.price)}</strong>
                    </div>
                  </div>
                </div>
              ))}
              {!topFlights.length && <p className="muted">No flight options available.</p>}
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">Itineraries</p>
                <h2>Curated plans</h2>
              </div>
              <p className="muted">Each itinerary bundles its matching destination and top travel options.</p>
            </div>
            <div className="itinerary-grid">
              {data.itineraries.map((plan, index) => (
                <div key={`${plan.rest_period.start_date}-${index}`} className="itinerary-card">
                  <div className="itinerary-header">
                    <div>
                      <h4>{getDestinationLabel(plan.destination)}</h4>
                      <p className="muted">{restRange(plan.rest_period)}</p>
                    </div>
                    <span className="chip">{plan.rest_period.days} days</span>
                  </div>
                  <div className="itinerary-body">
                    <div>
                      <p className="muted">Flights</p>
                      <strong>{plan.flights.length || data.flights.length} options</strong>
                    </div>
                    <div>
                      <p className="muted">Lodging</p>
                      <strong>{plan.lodging.length || data.lodging.length} options</strong>
                    </div>
                    <div>
                      <p className="muted">Notes</p>
                      <strong>{plan.notes ?? "Auto-compiled"}</strong>
                    </div>
                  </div>
                </div>
              ))}
              {!data.itineraries.length && <p className="muted">No itinerary plans available.</p>}
            </div>
          </section>
          </>
        ))}
    </div>
  );
}
