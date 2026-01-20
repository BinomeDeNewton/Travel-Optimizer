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
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
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
import { useI18n } from "./i18n";

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

const makePeriodKey = (period: RestPeriod) => `${period.start_date}|${period.end_date}`;

const safetyClass = (level?: string | null) => {
  const value = (level ?? "").toLowerCase();
  if (value.includes("low")) return "safety-low";
  if (value.includes("moderate")) return "safety-moderate";
  if (value.includes("high")) return "safety-high";
  if (value.includes("critical")) return "safety-critical";
  return "safety-unknown";
};

type SourceState = { kind: "none" | "live" | "file"; label?: string };
type ThemeMode = "light" | "dark";

const LARGE_SCAN_THRESHOLD = 1200;
const THEME_STORAGE_KEY = "travel-optimizer-theme";

const getInitialTheme = (): ThemeMode => {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
};

const continentKeyFromLabel = (label: string) => label.toLowerCase().replace(/\s+/g, "-");

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const resolvedLocale = locale === "fr" ? "fr-FR" : "en-US";
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [data, setData] = useState<PipelineResult | null>(null);
  const [source, setSource] = useState<SourceState>({ kind: "none" });
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"optimizer" | "insights" | "queue">("optimizer");
  const [formatConfig, setFormatConfig] = useState<FormatConfig>(() => ({
    locale: resolvedLocale,
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
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    setFormatConfig((current) => ({ ...current, locale: resolvedLocale }));
    setError(null);
    setApiError(null);
    setInsightsError(null);
    setJobsError(null);
    setOptionsError(null);
  }, [resolvedLocale]);

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
        setOptionsError(t("error.missingLocationData"));
      }
    };
    loadOptions();
  }, [t]);

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
              locale: resolvedLocale,
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

  const haulOptions = useMemo(
    () => [
      { value: "short", label: t("haul.short") },
      { value: "medium", label: t("haul.medium") },
      { value: "long", label: t("haul.long") },
      { value: "ultra", label: t("haul.ultra") }
    ],
    [t]
  );

  const formatJobStatus = (status: JobInfo["status"]) => t(`job.status.${status}`);

  const formatJobKind = (kind: string) => {
    const translated = t(`job.kind.${kind}`);
    return translated === `job.kind.${kind}` ? kind.replace(/-/g, " ") : translated;
  };

  const continentLabels = useMemo(() => {
    const map = new Map<string, string>();
    continentOrder.forEach((label) => {
      map.set(label, t(`continent.${continentKeyFromLabel(label)}`));
    });
    return map;
  }, [t]);

  const resolveContinentLabel = (name?: string | null) => {
    const key = getContinentLabel(name);
    return continentLabels.get(key) ?? t("continent.other");
  };

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
    const ranks = new Map(
      continentOrder.map((label, index) => [continentLabels.get(label) ?? label, index])
    );
    const options = countries.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.code ?? undefined,
      flag: flagEmoji(entry.code),
      group: resolveContinentLabel(entry.name)
    }));
    options.sort((a, b) => {
      const rankA = ranks.get(a.group ?? t("continent.other")) ?? ranks.size;
      const rankB = ranks.get(b.group ?? t("continent.other")) ?? ranks.size;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
    return options;
  }, [countries, continentLabels, resolveContinentLabel, t]);

  const originCountryOptions = useMemo<MultiSelectOption[]>(() => {
    const ranks = new Map(
      continentOrder.map((label, index) => [continentLabels.get(label) ?? label, index])
    );
    const options = countries.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.code ?? undefined,
      flag: flagEmoji(entry.code),
      group: resolveContinentLabel(entry.name)
    }));
    options.sort((a, b) => {
      const rankA = ranks.get(a.group ?? t("continent.other")) ?? ranks.size;
      const rankB = ranks.get(b.group ?? t("continent.other")) ?? ranks.size;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
    return options;
  }, [countries, continentLabels, resolveContinentLabel, t]);

  const insightsCountryOptions = useMemo<MultiSelectOption[]>(() => {
    const ranks = new Map(
      continentOrder.map((label, index) => [continentLabels.get(label) ?? label, index])
    );
    const options = countries.map((entry) => ({
      value: entry.name,
      label: entry.name,
      hint: entry.code ?? undefined,
      flag: flagEmoji(entry.code),
      group: resolveContinentLabel(entry.name)
    }));
    options.sort((a, b) => {
      const rankA = ranks.get(a.group ?? t("continent.other")) ?? ranks.size;
      const rankB = ranks.get(b.group ?? t("continent.other")) ?? ranks.size;
      if (rankA !== rankB) return rankA - rankB;
      return a.label.localeCompare(b.label);
    });
    return options;
  }, [countries, continentLabels, resolveContinentLabel, t]);

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
        group: city ? city[0].toUpperCase() : t("label.cities")
      };
    });
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [cities, homeCountry, t]);

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
        group: city ? city[0].toUpperCase() : t("label.cities")
      };
    });
    options.sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [insightsOriginCities, t]);

  const insightsOriginCitySet = useMemo(
    () => new Set(insightsOriginCityOptions.map((option) => option.value)),
    [insightsOriginCityOptions]
  );

  const originLabel = useMemo(() => {
    if (insightsOriginCity) {
      return insightsOriginCountry ? `${insightsOriginCity}, ${insightsOriginCountry.name}` : insightsOriginCity;
    }
    return insightsOriginCountry?.name ?? t("label.origin");
  }, [insightsOriginCity, insightsOriginCountry, t]);

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
    if (!tripRange.minDays) return t("common.na");
    return tripRange.minDays === tripRange.maxDays
      ? t("count.days", { count: tripRange.minDays })
      : t("label.daysRange", { min: tripRange.minDays, max: tripRange.maxDays });
  }, [tripRange.minDays, tripRange.maxDays, t]);

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
    if (!flight) return { route: t("common.na"), metric, date: "" };
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
      ? t("label.stopsCount", { count: flightHighlights.fewestStops.stops })
      : t("common.na");
  const bestScoreMetric =
    flightHighlights && typeof flightHighlights.bestScore?.score === "number"
      ? t("label.scoreValue", { score: flightHighlights.bestScore.score.toFixed(1) })
      : t("common.na");

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
        setSource({ kind: "file", label: file.name });
        setError(null);
        setLastPipelineRun(new Date().toISOString());
        setSelectedPeriodKey(null);
        setHoveredPeriodKey(null);
        if (payload.meta) {
          setFormatConfig((current) => ({
            locale: resolvedLocale,
            timeZone: payload.meta?.timezone ?? current.timeZone,
            currency: payload.meta?.currency ?? current.currency
          }));
        }
      } catch (err) {
        setError(t("error.invalidJson"));
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
    setSource({ kind: "none" });
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
      pushEvent(
        t("calendar.ics.restWindow"),
        period.start_date,
        addDays(period.end_date, 1),
        t("calendar.ics.restWindowDesc")
      );
    });

    data.timeoff.day_map.forEach((day) => {
      if (day.leave && day.leave !== "NONE") {
        const summary = day.reason ? day.reason : t("calendar.ics.optimizedLeave");
        pushEvent(summary, day.date, addDays(day.date, 1));
        return;
      }
      if (day.base_kind === "HOLIDAY") {
        const summary = day.holiday_name
          ? t("calendar.ics.holidayNamed", { name: day.holiday_name })
          : t("calendar.ics.holiday");
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
      setJobsError(err instanceof Error ? err.message : t("error.unableFetchQueue"));
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
      setApiError(t("error.apiOffline"));
      return;
    }
    if (!Number.isFinite(year) || year < 1900 || year > 2100) {
      setApiError(t("error.invalidYear"));
      return;
    }
    if (!Number.isFinite(leaveDays) || leaveDays < 0 || leaveDays > 365) {
      setApiError(t("error.invalidLeaveDays"));
      return;
    }
    if (!Number.isFinite(minRest) || minRest < 1 || minRest > 60) {
      setApiError(t("error.invalidMinRest"));
      return;
    }
    if (!homeCountry) {
      setApiError(t("error.missingHomeCountry"));
      return;
    }
    if (!homeCountry.code) {
      setApiError(t("error.invalidHomeCountryCode"));
      return;
    }
    if (!preferredCountries.length && !preferredCities.length) {
      setApiError(t("error.missingPreferredDestinations"));
      return;
    }
    const homeCityValue = homeCity.trim();
    if (homeCityValue && !homeCitySet.has(homeCityValue)) {
      setApiError(t("error.invalidHomeCity"));
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
      setSource({ kind: "live" });
      setError(null);
      setLastPipelineRun(new Date().toISOString());
      setSelectedPeriodKey(null);
      setHoveredPeriodKey(null);
      if (result.meta) {
        setFormatConfig((current) => ({
          locale: resolvedLocale,
          timeZone: result.meta?.timezone ?? current.timeZone,
          currency: result.meta?.currency ?? current.currency
        }));
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : t("error.unableRunOptimizer"));
    } finally {
      setRunning(false);
    }
  };

  const handleInsights = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!insightsOriginCountry) {
      setInsightsError(t("error.missingInsightsOriginCountry"));
      return;
    }
    if (!insightsCountries.length) {
      setInsightsError(t("error.missingInsightsDestinations"));
      return;
    }
    const originCityValue = insightsOriginCity.trim();
    if (originCityValue && !insightsOriginCitySet.has(originCityValue)) {
      setInsightsError(t("error.invalidInsightsOriginCity"));
      return;
    }
    const departStartDate = parseISODate(departStart);
    const departEndDate = parseISODate(departEnd);
    const returnStartDate = parseISODate(returnStart);
    const returnEndDate = parseISODate(returnEnd);
    if (departStartDate > departEndDate) {
      setInsightsError(t("error.invalidDepartureWindow"));
      return;
    }
    if (returnStartDate > returnEndDate) {
      setInsightsError(t("error.invalidReturnWindow"));
      return;
    }
    if (returnStartDate < departStartDate) {
      setInsightsError(t("error.invalidReturnAfterDeparture"));
      return;
    }
    if (isLargeScan && !confirmLargeScan) {
      setInsightsError(t("error.confirmLargeScan", { count: datePairCount }));
      return;
    }
    if (hasSameActiveInsightsJob && !confirmRerun) {
      setInsightsError(t("error.confirmRerun"));
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
      setInsightsError(err instanceof Error ? err.message : t("error.unableQueueInsights"));
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
            locale: resolvedLocale,
            timeZone: payload.result?.meta?.timezone ?? current.timeZone,
            currency: payload.result?.meta?.currency ?? current.currency
          }));
        }
      }
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : t("error.unableLoadJobResults"));
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
      setJobsError(err instanceof Error ? err.message : t("error.unableCancelJob"));
    }
  };

  const getDestinationLabel = (destination: DestinationSuggestion | null) => {
    if (!destination) return t("label.pending");
    const flag = flagEmoji(destination.country_code ?? countryCodeByName.get(destination.country));
    const cities = destination.cities.length ? destination.cities.join(", ") : t("label.general");
    return `${flag ? `${flag} ` : ""}${destination.country} · ${cities}`;
  };

  const renderFlightInsightCard = (title: string, options: FlightInsightsResult["top_price"]) => (
    <div className="insight-card">
      <div className="insight-header">
        <h4>{title}</h4>
        <span className="chip">{t("label.topCount", { count: options.length })}</span>
      </div>
      <div className="insight-list">
        {options.length ? (
          options.map((option, index) => {
            const durationLabel = option.duration ? option.duration : formatDuration(option.total_duration_min);
            const carrierLabel = option.flight_name
              ? t("label.carrierValue", { value: option.flight_name })
              : t("label.carrierUnknown");
            const timeLabel =
              option.departure_time && option.arrival_time
                ? t("label.timesValue", {
                    value: `${option.departure_time} → ${option.arrival_time}${
                      option.arrival_time_ahead ? ` (${option.arrival_time_ahead})` : ""
                    }`
                  })
                : t("label.timesUnknown");
            const routeLabel = (option.itinerary_route ?? option.segment_route_group ?? t("common.na")).replace(
              />/g,
              " → "
            );
            const tripLabel = option.trip_type
              ? (() => {
                  const key = `label.tripType.${option.trip_type}`;
                  const translated = t(key);
                  return translated === key ? option.trip_type.replace("-", " ") : translated;
                })()
              : t("label.tripDefault");
            const stopsLabel =
              typeof option.stops === "number" ? t("label.stopsCount", { count: option.stops }) : t("common.na");
            return (
              <div key={`${option.origin_iata}-${option.destination_iata}-${index}`} className="insight-row">
                <div>
                  <strong>
                    {option.origin_iata} → {option.destination_iata}
                  </strong>
                  <p className="muted">
                    {formatDateValue(option.depart_date)} ·{" "}
                    {option.return_date ? formatDateValue(option.return_date) : t("label.oneWay")}
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
                  <span>{stopsLabel}</span>
                </div>
              </div>
            );
          })
        ) : (
          <p className="muted">{t("empty.noOptions")}</p>
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

  const apiLabel = t(`status.api.${apiStatus}`);
  const sourceValue = source.kind === "file" ? source.label ?? t("source.file") : t(`source.${source.kind}`);
  const originFlag = flagEmoji(insightsOriginCountry?.code);
  const hasItineraryInputs = insightCountryList.length > 0 && tripRange.minDays > 0;
  const insightsReport = insights?.artifacts?.report_excel;

  return (
    <div className="app">
      <div className="app-glow" />
      <header className="hero" data-animate>
        <div className="hero-top">
          <div>
            <p className="eyebrow">{t("app.name")}</p>
            <h1>{t("app.heroTitle")}</h1>
            <p className="subtitle">{t("app.heroSubtitle")}</p>
          </div>
          <div className="source-card">
            {tab === "optimizer" ? (
              <>
                <span className="source-label">{t("source.loadedLabel")}</span>
                <span className="source-value">{sourceValue}</span>
                <div className="status-row">
                  <span className={`status-pill ${apiStatus}`}>
                    <span className="status-dot" />
                    {apiLabel}
                  </span>
                  <span className="status-meta">
                    {t("status.lastRun", { time: formatDateTimeValue(lastPipelineRun) })}
                  </span>
                </div>
                {data ? (
                  <div className="source-meta">
                    <span>{t("count.destinations", { count: data.destinations.length })}</span>
                    <span>{t("count.flights", { count: data.flights.length })}</span>
                    <span>{t("count.itineraries", { count: data.itineraries.length })}</span>
                  </div>
                ) : (
                  <span className="source-hint">{t("source.optimizerHint")}</span>
                )}
              </>
            ) : tab === "insights" ? (
              <>
                <span className="source-label">{t("source.insightsLabel")}</span>
                <span className="source-value">
                  {insights ? t("source.latestScanReady") : t("source.noScanYet")}
                </span>
                <div className="status-row">
                  <span className={`status-pill ${apiStatus}`}>
                    <span className="status-dot" />
                    {apiLabel}
                  </span>
                  <span className="status-meta">
                    {t("status.lastScan", { time: formatDateTimeValue(lastInsightsRun) })}
                  </span>
                </div>
                {insights ? (
                  <div className="source-meta">
                    <span>{t("count.options", { count: insights.summary.options })}</span>
                    <span>
                      {insights.summary.origin_airports.join(", ") || t("common.na")} {t("label.originShort")}
                    </span>
                    <span>{t("count.destinations", { count: insights.summary.destination_airports.length })}</span>
                  </div>
                ) : (
                  <span className="source-hint">{t("source.insightsHint")}</span>
                )}
              </>
            ) : (
              <>
                <span className="source-label">{t("source.queueLabel")}</span>
                <span className="source-value">
                  {jobs.length ? t("count.jobs", { count: jobs.length }) : t("source.noJobsYet")}
                </span>
                <div className="status-row">
                  <span className={`status-pill ${apiStatus}`}>
                    <span className="status-dot" />
                    {apiLabel}
                  </span>
                  <span className="status-meta">
                    {hasActiveJobs ? t("status.activeJobs") : t("status.queueIdle")}
                  </span>
                </div>
                {activeJobId ? (
                  <span className="source-hint">{t("source.trackingJob", { id: activeJobId })}</span>
                ) : (
                  <span className="source-hint">{t("source.queueHint")}</span>
                )}
              </>
            )}
            <div className="source-controls">
              <div className="source-control">
                <span className="source-label">{t("theme.label")}</span>
                <div className="switch-row">
                  <span className="muted">{t("theme.light")}</span>
                  <Switch
                    checked={theme === "dark"}
                    onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                    aria-label={t("action.toggleTheme")}
                  />
                  <span className="muted">{t("theme.dark")}</span>
                </div>
              </div>
              <div className="source-control">
                <span className="source-label">{t("language.label")}</span>
                <div className="language-toggle">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocale("en")}
                    data-active={locale === "en"}
                  >
                    EN
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocale("fr")}
                    data-active={locale === "fr"}
                  >
                    FR
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
        {tab === "optimizer" && (
          <div className="controls" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
            <label className="upload">
              <input type="file" accept="application/json" onChange={handleFileInput} />
              <span>{t("action.uploadJson")}</span>
            </label>
            <button className="ghost" type="button" onClick={handleClear}>
              {t("action.clear")}
            </button>
            <button className="ghost" type="button" onClick={handleExport} disabled={!data}>
              {t("action.downloadJson")}
            </button>
            {error && <span className="error">{error}</span>}
          </div>
        )}
      </header>

      <section className="section control-panel" data-animate>
        <div className="section-header">
          <div>
            <p className="eyebrow">{t("nav.missionControl")}</p>
            <h2>{t("nav.chooseModule")}</h2>
          </div>
        </div>
        <div className="module-grid">
          <button
            type="button"
            className={`module-card ${tab === "optimizer" ? "active" : ""}`}
            onClick={() => setTab("optimizer")}
          >
            <div className="module-card-header">
              <span className="module-badge">{t("module.oneBadge")}</span>
              <span className="module-tag">{t("module.oneTag")}</span>
            </div>
            <h3>{t("module.oneTitle")}</h3>
            <p className="muted">{t("module.oneDesc")}</p>
          </button>
          <button
            type="button"
            className={`module-card ${tab === "insights" ? "active" : ""}`}
            onClick={() => setTab("insights")}
          >
            <div className="module-card-header">
              <span className="module-badge">{t("module.twoBadge")}</span>
              <span className="module-tag">{t("module.twoTag")}</span>
            </div>
            <h3>{t("module.twoTitle")}</h3>
            <p className="muted">{t("module.twoDesc")}</p>
          </button>
        </div>
        {optionsError && <p className="error">{optionsError}</p>}
        {tab === "optimizer" ? (
          <form className="panel-grid" onSubmit={handleRun}>
            <div className="panel-card">
              <h3>{t("section.leaveSetup")}</h3>
              <p className="muted">{t("section.leaveSetupDesc")}</p>
              <div className="field">
                <label>{t("field.year")}</label>
                <Input
                  type="number"
                  min={2000}
                  value={year}
                  onChange={(event) => setYear(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label>{t("field.leaveDays")}</label>
                <Input
                  type="number"
                  min={0}
                  value={leaveDays}
                  onChange={(event) => setLeaveDays(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label>{t("field.minRest")}</label>
                <Input
                  type="number"
                  min={1}
                  value={minRest}
                  onChange={(event) => setMinRest(Number(event.target.value))}
                />
              </div>
              <div className="field">
                <label>{t("field.countryResidence")}</label>
                <OriginCountryPicker
                  options={originCountryOptions}
                  value={homeCountry?.name ?? null}
                  onChange={(nextValue) => {
                    const match = nextValue ? countries.find((country) => country.name === nextValue) ?? null : null;
                    setHomeCountry(match);
                    setHomeCity("");
                  }}
                  placeholder={t("picker.country.placeholder")}
                  emptyMessage={t("picker.country.empty")}
                  title={t("picker.homeCountry.title")}
                  subtitle={t("picker.homeCountry.subtitle")}
                  badgeFallback={t("picker.homeCountry.badge")}
                  searchPlaceholder={t("picker.country.search")}
                />
              </div>
              <div className="field">
                <label>{t("field.homeCity")}</label>
                <OriginCityPicker
                  options={homeCityPickerOptions}
                  value={homeCity || null}
                  onChange={(nextValue) => setHomeCity(nextValue ?? "")}
                  placeholder={homeCountry ? t("picker.city.placeholder") : t("picker.city.placeholderDisabled")}
                  emptyMessage={homeCountry ? t("picker.city.empty") : t("picker.city.emptyDisabled")}
                  disabled={!homeCountry}
                  title={t("picker.homeCity.title")}
                  subtitle={t("picker.homeCity.subtitle")}
                  badgeFallback={t("picker.homeCity.badge")}
                  searchPlaceholder={t("picker.city.search")}
                />
              </div>
            </div>

            <div className="panel-card">
              <h3>{t("section.destinationFilters")}</h3>
              <p className="muted">{t("section.destinationFiltersHelp")}</p>
              <div className="field">
                <label>{t("field.preferredCities")}</label>
                <DestinationCountryPicker
                  options={cityOptions}
                  selected={preferredCities}
                  onChange={setPreferredCities}
                  placeholder={t("picker.preferredCities.placeholder")}
                  emptyMessage={t("picker.preferredCities.empty")}
                  title={t("picker.preferredCities.title")}
                  subtitle={t("picker.preferredCities.subtitle")}
                  searchPlaceholder={t("picker.preferredCities.search")}
                  emptyState={t("picker.preferredCities.emptyState")}
                  maxVisible={200}
                />
              </div>
              <div className="field">
                <label>{t("field.preferredCountries")}</label>
                <DestinationCountryPicker
                  options={preferredCountryOptions}
                  selected={preferredCountries}
                  onChange={setPreferredCountries}
                  placeholder={t("picker.preferredCountries.placeholder")}
                  emptyMessage={t("picker.preferredCountries.empty")}
                  title={t("picker.preferredCountries.title")}
                  subtitle={t("picker.preferredCountries.subtitle")}
                  searchPlaceholder={t("picker.preferredCountries.search")}
                  emptyState={t("picker.preferredCountries.emptyState")}
                />
              </div>
              <div className="field">
                <label>{t("field.haulTypes")}</label>
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
                {t("action.resetFilters")}
              </button>
            </div>

            <div className="panel-card">
              <h3>{t("section.runOptimizer")}</h3>
              <p className="muted">{t("section.runOptimizerDesc")}</p>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={fastMode}
                  onChange={(event) => setFastMode(event.target.checked)}
                />
                {t("label.fastMode")}
              </label>
              <span className="helper-text">{t("helper.fastMode")}</span>
              <button className="primary" type="submit" disabled={running}>
                {running ? t("status.running") : t("action.launchOptimization")}
              </button>
              {apiError && <p className="error">{apiError}</p>}
            </div>
          </form>
        ) : tab === "insights" ? (
          <form className="panel-grid" onSubmit={handleInsights}>
            <div className="panel-card">
              <h3>{t("section.originDates")}</h3>
              <div className="field">
                <label>{t("field.originCountry")}</label>
                <OriginCountryPicker
                  options={originCountryOptions}
                  value={insightsOriginCountry?.name ?? null}
                  onChange={(nextValue) => {
                    const match = nextValue ? countries.find((country) => country.name === nextValue) ?? null : null;
                    setInsightsOriginCountry(match);
                    setInsightsOriginCity("");
                  }}
                  placeholder={t("picker.country.placeholder")}
                  emptyMessage={t("picker.country.empty")}
                  title={t("picker.originCountry.title")}
                  subtitle={t("picker.originCountry.subtitle")}
                  badgeFallback={t("picker.originCountry.badge")}
                  searchPlaceholder={t("picker.country.search")}
                />
              </div>
              <div className="field">
                <label>{t("field.originCity")}</label>
                <OriginCityPicker
                  options={insightsOriginCityOptions}
                  value={insightsOriginCity || null}
                  onChange={(nextValue) => setInsightsOriginCity(nextValue ?? "")}
                  placeholder={
                    insightsOriginCountry
                      ? t("picker.originCity.placeholder")
                      : t("picker.originCity.placeholderDisabled")
                  }
                  emptyMessage={
                    insightsOriginCountry ? t("picker.originCity.empty") : t("picker.originCity.emptyDisabled")
                  }
                  disabled={!insightsOriginCountry}
                  title={t("picker.originCity.title")}
                  subtitle={t("picker.originCity.subtitle")}
                  badgeFallback={t("picker.originCity.badge")}
                  searchPlaceholder={t("picker.originCity.search")}
                />
              </div>
              <div className="date-panel">
                <div className="date-picker">
                  <div className="date-picker-header">
                    <div>
                      <label>{t("label.departureWindow")}</label>
                      <p className="muted">{t("label.pickDateRange")}</p>
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
                      <label>{t("label.returnWindow")}</label>
                      <p className="muted">{t("label.pickReturnRange")}</p>
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
              <h3>{t("section.destinationCountries")}</h3>
              <div className="field">
                <label>{t("field.targetCountries")}</label>
                <DestinationCountryPicker
                  options={insightsCountryOptions}
                  selected={insightsCountries}
                  onChange={setInsightsCountries}
                  placeholder={t("picker.destinationCountries.placeholder")}
                  emptyMessage={t("picker.destinationCountries.empty")}
                />
              </div>
            </div>

            <div className="panel-card">
              <h3>{t("section.runInsights")}</h3>
              <p className="muted">{t("section.runInsightsDesc")}</p>
              {isLargeScan && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmLargeScan}
                    onChange={(event) => setConfirmLargeScan(event.target.checked)}
                  />
                  {t("label.confirmLargeScan", { count: datePairCount })}
                </label>
              )}
              {hasSameActiveInsightsJob && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirmRerun}
                    onChange={(event) => setConfirmRerun(event.target.checked)}
                  />
                  {t("label.confirmRerun")}
                </label>
              )}
              <button className="primary" type="submit" disabled={insightsLoading}>
                {insightsLoading ? t("status.scanning") : t("action.runFlightInsights")}
              </button>
              <span className="helper-text">{t("helper.jobsBackground")}</span>
              <div className="insight-plan">
                <div className="plan-row">
                  <span className="plan-label">{t("plan.origin")}</span>
                  <span>{originLabel}</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">{t("plan.destinationCountries")}</span>
                  <span>{t("plan.selectedCount", { count: insightsCountries.length || 0 })}</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">{t("plan.departureDates")}</span>
                  <span>{t("count.days", { count: departWindowDays })}</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">{t("plan.returnDates")}</span>
                  <span>{t("count.days", { count: returnWindowDays })}</span>
                </div>
                <div className="plan-row">
                  <span className="plan-label">{t("plan.dateCombinations")}</span>
                  <span>{t("plan.pairsCount", { count: datePairCount })}</span>
                </div>
                <p className="muted">{t("plan.description")}</p>
              </div>
              <span className="status-meta">
                {t("status.lastRun", { time: formatDateTimeValue(lastInsightsRun) })}
              </span>
              {insightsError && <p className="error">{insightsError}</p>}
            </div>
          </form>
        ) : (
          <div className="panel-grid">
            <div className="panel-card">
              <h3>{t("section.queueControl")}</h3>
              <p className="muted">{t("section.queueControlDesc")}</p>
              <div className="controls">
                <button className="ghost" type="button" onClick={() => refreshJobs(true)}>
                  {jobsLoading ? t("status.refreshing") : t("action.refreshQueue")}
                </button>
                <span className="status-meta">
                  {hasActiveJobs ? t("status.activeJobs") : t("status.noActiveJobs")}
                </span>
              </div>
              {jobsError && <p className="error">{jobsError}</p>}
            </div>
            <div className="panel-card">
              <h3>{t("section.queueNext")}</h3>
              <p className="muted">{t("section.queueNextDesc")}</p>
              <div className="queue-steps">
                <span className="chip">1</span>
                <span>{t("queue.step.loadAirports")}</span>
                <span className="chip">2</span>
                <span>{t("queue.step.buildMatrix")}</span>
                <span className="chip">3</span>
                <span>{t("queue.step.scanFlights")}</span>
                <span className="chip">4</span>
                <span>{t("queue.step.cleanRank")}</span>
              </div>
              {activeJobId && (
                <span className="status-meta">{t("status.latestJobId", { id: activeJobId })}</span>
              )}
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
                    <p className="eyebrow">{t("section.flightInsights")}</p>
                    <h2>{t("section.plannerHighlights")}</h2>
                  </div>
                  <div className="insight-actions">
                    <div className="pill">
                      {t("insights.summary", {
                        count: insights.summary.options,
                        origins: insights.summary.origin_airports.join(", ")
                      })}
                    </div>
                    {insightsReport && (
                      <a className="ghost" href={insightsReport.url} download>
                        {t("action.downloadExcel")}
                      </a>
                    )}
                  </div>
                </div>
                <div className="stats">
                  <div className="stat-card">
                    <p>{t("stats.departureWindow")}</p>
                    <h3>
                      {formatDateValue(insights.summary.depart_start)} - {formatDateValue(insights.summary.depart_end)}
                    </h3>
                    <span>
                      {t("stats.returnWindow", {
                        start: formatDateValue(insights.summary.return_start),
                        end: formatDateValue(insights.summary.return_end)
                      })}
                    </span>
                  </div>
                  <div className="stat-card">
                    <p>{t("stats.originAirports")}</p>
                    <h3>{insights.summary.origin_airports.join(", ")}</h3>
                    <span>{t("stats.currency", { currency: insights.summary.currency })}</span>
                  </div>
                  <div className="stat-card">
                    <p>{t("stats.destinationAirports")}</p>
                    <h3>{insights.summary.destination_airports.slice(0, 6).join(", ")}</h3>
                    <span>{t("stats.totalAirports", { count: insights.summary.destination_airports.length })}</span>
                  </div>
                </div>
                <div className="insights-grid">
                  {renderFlightInsightCard(t("insights.card.bestPrices"), insights.top_price)}
                  {renderFlightInsightCard(t("insights.card.fastestRoutes"), insights.top_duration)}
                  {renderFlightInsightCard(t("insights.card.fewestStops"), insights.top_fewest_stops)}
                  {renderFlightInsightCard(t("insights.card.topScores"), insights.top_score)}
                </div>
              </>
            ) : (
              <div className="empty empty-compact">
                <h2>{t("empty.noInsightsTitle")}</h2>
                <p>{t("empty.noInsightsDesc")}</p>
              </div>
            )}
          </section>
          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.chaslesItineraries")}</p>
                <h2>{t("section.chaslesTitle")}</h2>
              </div>
              <div className="pill">{tripRangeLabel}</div>
            </div>
            <p className="muted">{t("section.chaslesDesc")}</p>
            {hasItineraryInputs ? (
              itineraryCategories.length ? (
                <div className="itinerary-studio">
                  {itineraryCategories.map((category) => (
                    <div key={category.key} className="itinerary-category">
                      <div className="itinerary-category-header">
                        <div>
                          <h3>{t(category.labelKey)}</h3>
                          <p className="muted">{t(category.descriptionKey)}</p>
                        </div>
                        <span className="chip">{t("count.routes", { count: category.suggestions.length })}</span>
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
                                <span className="stop-chip travel-chip">
                                  {t("label.travelDays", { count: suggestion.travelDays })}
                                </span>
                              </div>
                              <div className="itinerary-meta">
                                <span className="chip">{t("label.totalDaysApprox", { count: suggestion.totalDays })}</span>
                                <span className="muted">{t("label.basedOnWindow", { range: tripRangeLabel })}</span>
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
                  <h2>{t("empty.noItinerariesTitle")}</h2>
                  <p>{t("empty.noItinerariesDesc")}</p>
                </div>
              )
            ) : (
              <div className="empty empty-compact">
                <h2>{t("empty.pickDestinationsTitle")}</h2>
                <p>{t("empty.pickDestinationsDesc")}</p>
              </div>
            )}
          </section>
        </>
      )}

      {tab === "queue" && (
        <section className="section" data-animate>
          <div className="section-header">
            <div>
              <p className="eyebrow">{t("section.flightJobs")}</p>
              <h2>{t("section.progressQueue")}</h2>
            </div>
            <div className="pill">{t("count.jobs", { count: jobs.length })}</div>
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
                    <span>{t("status.updated", { time: formatJobTimeValue(job.updated_at) })}</span>
                  </div>
                  <p className="job-stage">{job.stage}</p>
                  <div
                    className="progress-bar"
                    role="progressbar"
                    aria-valuenow={job.progress * 100}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t("status.jobProgress")}
                  >
                    <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                  </div>
                  {job.error && <p className="error">{job.error}</p>}
                  <div className="job-actions">
                    {(job.status === "running" || job.status === "queued") && (
                      <button className="ghost" type="button" onClick={() => handleCancelJob(job.id)}>
                        {t("action.cancelJob")}
                      </button>
                    )}
                    {job.status === "completed" && (
                      <button className="primary" type="button" onClick={() => handleLoadJobResult(job.id)}>
                        {t("action.loadResults")}
                      </button>
                    )}
                  </div>
                  <span className="status-meta">{t("status.jobId", { id: job.id })}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty empty-compact">
              <h2>{t("empty.noJobsTitle")}</h2>
              <p>{t("empty.noJobsDesc")}</p>
            </div>
          )}
        </section>
      )}

      {tab === "optimizer" &&
        (!data ? (
          <section className="empty" data-animate>
            <h2>{t("empty.noResultsTitle")}</h2>
            <p>{t("empty.noResultsDesc")}</p>
          </section>
        ) : (
          <>
          <section className="stats" data-animate>
            <div className="stat-card">
              <p>{t("stats.totalRestDays")}</p>
              <h3>{data.timeoff.total_rest_days}</h3>
              <span>{t("stats.acrossWindows", { count: data.timeoff.rest_periods.length })}</span>
            </div>
            <div className="stat-card">
              <p>{t("stats.paidLeaveUsed")}</p>
              <h3>{data.timeoff.used_leave_days}</h3>
              <span>{t("stats.unusedLeave", { count: data.timeoff.unused_leave_days })}</span>
            </div>
            <div className="stat-card">
              <p>{t("stats.optimizationScore")}</p>
              <h3>{data.timeoff.score.toFixed(1)}</h3>
              <span>{t("stats.compositeRestIndex")}</span>
            </div>
            <div className="stat-card accent">
              <p>{t("stats.destinations")}</p>
              <h3>{data.destinations.length}</h3>
              <span>{t("stats.flightOptions", { count: data.flights.length })}</span>
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.optimizedCalendar")}</p>
                <h2>{t("section.optimizedCalendarTitle")}</h2>
              </div>
              <div className="calendar-actions">
                <div className="pill">{t("stats.restWindows", { count: data.timeoff.rest_periods.length })}</div>
                <button className="ghost" type="button" onClick={handleExportICS}>
                  {t("action.downloadCalendar")}
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
                    {t("legend.weekend")}
                  </div>
                  <div className="legend-item">
                    <span className="legend-swatch holiday" />
                    {t("legend.holiday")}
                  </div>
                  <div className="legend-item">
                    <span className="legend-swatch closure" />
                    {t("legend.closure")}
                  </div>
                  <div className="legend-item">
                    <span className="legend-swatch leave" />
                    {t("legend.optimizedLeave")}
                  </div>
                </div>
              </div>
              <div className="calendar-panel">
                <div className="calendar-panel-header">
                  <h3>{t("calendar.restWindows")}</h3>
                  <p className="muted">{t("calendar.restWindowsHint")}</p>
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
                        <span className="muted">{t("count.days", { count: entry.period.days })}</span>
                      </button>
                    );
                  })}
                  {!periodDetails.length && <p className="muted">{t("calendar.noRestWindows")}</p>}
                </div>
                {activePeriod ? (
                  <div className="period-detail">
                    <div>
                      <h4>{restRange(activePeriod.period)}</h4>
                      <p className="muted">{t("calendar.daysOfRest", { count: activePeriod.period.days })}</p>
                    </div>
                    {periodStats.get(makePeriodKey(activePeriod.period)) && (
                      <div className="period-stats">
                        <span className="chip">
                          {t("calendar.stats.optimizedLeave", {
                            count: periodStats.get(makePeriodKey(activePeriod.period))?.leave ?? 0
                          })}
                        </span>
                        <span className="chip">
                          {t("calendar.stats.holidays", {
                            count: periodStats.get(makePeriodKey(activePeriod.period))?.holiday ?? 0
                          })}
                        </span>
                        <span className="chip">
                          {t("calendar.stats.weekendDays", {
                            count: periodStats.get(makePeriodKey(activePeriod.period))?.weekend ?? 0
                          })}
                        </span>
                        <span className="chip">
                          {t("calendar.stats.closures", {
                            count: periodStats.get(makePeriodKey(activePeriod.period))?.closure ?? 0
                          })}
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
                        <span className="muted">{t("calendar.noDestinations")}</span>
                      )}
                    </div>
                    <button
                      className="primary"
                      type="button"
                      onClick={() => handleUsePeriodForInsights(activePeriod.period, activePeriod.countries)}
                      disabled={!activePeriod.countries.length}
                    >
                      {t("action.useWindowForInsights")}
                    </button>
                  </div>
                ) : (
                  <div className="period-detail empty-detail">
                    <p className="muted">{t("calendar.hoverHint")}</p>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.timeoffIntelligence")}</p>
                <h2>{t("section.restPeriodMap")}</h2>
              </div>
              {data.timeoff.best_month && (
                <div className="pill">
                  {t("stats.bestMonth", {
                    month: data.timeoff.best_month.month,
                    efficiency: data.timeoff.best_month.efficiency.toFixed(2)
                  })}
                </div>
              )}
            </div>
            <div className="rest-grid">
              {data.timeoff.rest_periods.map((period, index) => (
                <div key={`${period.start_date}-${index}`} className="rest-card">
                  <div>
                    <h4>{restRange(period)}</h4>
                    <p className="muted">{t("count.days", { count: period.days })}</p>
                  </div>
                  <span className="chip">{t("label.windowIndex", { index: index + 1 })}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.destinations")}</p>
                <h2>{t("section.shortlistedPlaces")}</h2>
              </div>
              <div className="pill">{t("count.matches", { count: filteredDestinations.length })}</div>
            </div>
            <div className="search-controls">
              <input
                placeholder={t("placeholder.searchDestinations")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={t("aria.searchDestinations")}
              />
              <select
                value={destHaulFilter}
                onChange={(event) => setDestHaulFilter(event.target.value)}
                aria-label={t("aria.filterHaul")}
              >
                <option value="all">{t("option.haul.all")}</option>
                <option value="short">{t("option.haul.short")}</option>
                <option value="medium">{t("option.haul.medium")}</option>
                <option value="long">{t("option.haul.long")}</option>
                <option value="ultra">{t("option.haul.ultra")}</option>
              </select>
              <select
                value={destSort}
                onChange={(event) => setDestSort(event.target.value)}
                aria-label={t("aria.sortResults")}
              >
                <option value="rest-desc">{t("option.sort.restDesc")}</option>
                <option value="rest-asc">{t("option.sort.restAsc")}</option>
                <option value="flight-hours">{t("option.sort.flightHours")}</option>
                <option value="country">{t("option.sort.country")}</option>
              </select>
              <input
                type="number"
                min={0}
                value={destMinDays}
                onChange={(event) => setDestMinDays(Number(event.target.value))}
                placeholder={t("placeholder.minRestDays")}
                aria-label={t("aria.minRestDays")}
              />
            </div>
            <div className="dest-grid">
              {filteredDestinations.map((dest, index) => {
                const flag = flagEmoji(dest.country_code ?? countryCodeByName.get(dest.country));
                const climateMonths = formatMonthsValue(dest.climate?.months);
                const haulLabel = dest.haul_category
                  ? t(`haul.${dest.haul_category}Label`)
                  : t("label.haulUnknown");
                const tempValue = dest.climate?.avg_temp_c;
                const rainValue = dest.climate?.precip_mm;
                const tempTitle = climateMonths
                  ? t("tooltip.avgTempMonths", { months: climateMonths, temp: tempValue })
                  : t("tooltip.avgTemp", { temp: tempValue });
                const rainTitle = climateMonths
                  ? t("tooltip.avgRainMonths", { months: climateMonths, precip: rainValue })
                  : t("tooltip.avgRain", { precip: rainValue });
                return (
                  <div key={`${dest.country}-${index}`} className="dest-card">
                    <div className="dest-header">
                      <div>
                        <h4>
                          {flag && <span className="flag">{flag}</span>} {dest.country}
                        </h4>
                        <p className="muted">{haulLabel}</p>
                      </div>
                      {dest.flight_hours && (
                        <span className="chip">{t("label.flightHours", { hours: dest.flight_hours })}</span>
                      )}
                    </div>
                    <div className="dest-badges">
                      {tempValue !== undefined && tempValue !== null && (
                        <span className="chip" title={tempTitle}>
                          {t("label.avgTemp", { temp: tempValue })}
                        </span>
                      )}
                      {rainValue !== undefined && rainValue !== null && (
                        <span className="chip" title={rainTitle}>
                          {t("label.avgRain", { precip: rainValue })}
                        </span>
                      )}
                      {dest.safety?.level && (
                        <span
                          className={`chip safety ${safetyClass(dest.safety.level)}`}
                          title={dest.safety.message ?? t("tooltip.safety")}
                        >
                          {t("label.safety", { level: dest.safety.level })}
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
                        <span className="muted">{t("label.generalCoverage")}</span>
                      )}
                    </div>
                    <div className="dest-meta">
                      <span className="pill">{restRange(dest.rest_period)}</span>
                      <span className="chip">
                        {t("label.fromAirports", { codes: dest.source_iata.join(", ") })}
                      </span>
                      <span className="chip">
                        {t("label.toAirports", { codes: dest.destination_iatas.join(", ") })}
                      </span>
                    </div>
                  </div>
                );
              })}
              {!filteredDestinations.length && <p className="muted">{t("empty.noDestinationsMatch")}</p>}
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.networkView")}</p>
                <h2>{t("section.routesMap")}</h2>
              </div>
              <p className="muted">{t("section.routesMapDesc")}</p>
            </div>
            <RoutesMap data={data} formatConfig={formatConfig} />
          </section>

          {flightHighlights && (
            <section className="section" data-animate>
              <div className="section-header">
                <div>
                  <p className="eyebrow">{t("section.flightHighlights")}</p>
                  <h2>{t("section.flightHighlightsTitle")}</h2>
                </div>
                <p className="muted">{t("section.flightHighlightsDesc")}</p>
              </div>
              <div className="highlight-grid">
                {renderHighlightCard(
                  t("label.bestPrice"),
                  flightHighlights.cheapest,
                  formatCurrencyValue(flightHighlights.cheapest?.price ?? null)
                )}
                {renderHighlightCard(
                  t("label.fastest"),
                  flightHighlights.fastest,
                  formatDuration(flightHighlights.fastest?.total_duration_min ?? null)
                )}
                {renderHighlightCard(
                  t("label.fewestStops"),
                  flightHighlights.fewestStops,
                  fewestStopsMetric
                )}
                {renderHighlightCard(
                  t("label.topScore"),
                  flightHighlights.bestScore,
                  bestScoreMetric
                )}
              </div>
            </section>
          )}

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.flights")}</p>
                <h2>{t("section.topFlightOptions")}</h2>
              </div>
              <p className="muted">{t("section.topFlightOptionsDesc")}</p>
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
                    <span>{flight.return_date ? formatDateValue(flight.return_date) : t("label.oneWay")}</span>
                  </div>
                  <div className="flight-details">
                    <div>
                      <p className="muted">{t("label.duration")}</p>
                      <strong>{formatDuration(flight.total_duration_min)}</strong>
                    </div>
                    <div>
                      <p className="muted">{t("label.stops")}</p>
                      <strong>{flight.stops ?? t("common.na")}</strong>
                    </div>
                    <div>
                      <p className="muted">{t("label.price")}</p>
                      <strong>{formatCurrencyValue(flight.price)}</strong>
                    </div>
                  </div>
                </div>
              ))}
              {!topFlights.length && <p className="muted">{t("empty.noFlights")}</p>}
            </div>
          </section>

          <section className="section" data-animate>
            <div className="section-header">
              <div>
                <p className="eyebrow">{t("section.itineraries")}</p>
                <h2>{t("section.curatedPlans")}</h2>
              </div>
              <p className="muted">{t("section.curatedPlansDesc")}</p>
            </div>
            <div className="itinerary-grid">
              {data.itineraries.map((plan, index) => (
                <div key={`${plan.rest_period.start_date}-${index}`} className="itinerary-card">
                  <div className="itinerary-header">
                    <div>
                      <h4>{getDestinationLabel(plan.destination)}</h4>
                      <p className="muted">{restRange(plan.rest_period)}</p>
                    </div>
                    <span className="chip">{t("count.days", { count: plan.rest_period.days })}</span>
                  </div>
                  <div className="itinerary-body">
                    <div>
                      <p className="muted">{t("label.flights")}</p>
                      <strong>{t("count.options", { count: plan.flights.length || data.flights.length })}</strong>
                    </div>
                    <div>
                      <p className="muted">{t("label.lodging")}</p>
                      <strong>{t("count.options", { count: plan.lodging.length || data.lodging.length })}</strong>
                    </div>
                    <div>
                      <p className="muted">{t("label.notes")}</p>
                      <strong>{plan.notes ?? t("label.autoCompiled")}</strong>
                    </div>
                  </div>
                </div>
              ))}
              {!data.itineraries.length && <p className="muted">{t("empty.noItineraryPlans")}</p>}
            </div>
          </section>
          </>
        ))}
    </div>
  );
}
