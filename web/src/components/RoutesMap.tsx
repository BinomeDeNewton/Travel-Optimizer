import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { DestinationSuggestion, FlightOption, PipelineResult, RestPeriod } from "../types";
import { FormatConfig, formatCurrency, formatDate, formatDuration } from "../utils/format";

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";
const ORIGIN_COLOR = "#1f8a70";
const DEST_COLOR = "#ff6b4a";
const HUB_COLOR = "#1c252a";

type AirportCoordinates = Record<string, [number, number]>; // [lon, lat]

type RouteInfo = {
  key: string;
  origin: string;
  destination: string;
  restPeriods: RestPeriod[];
  flightCount: number;
  minPrice: number | null;
  minDuration: number | null;
  minStops: number | null;
};

type AirportInfo = {
  code: string;
  role: "origin" | "destination" | "hub";
  routeCount: number;
  coordinates: [number, number];
};

type LineFeature = {
  type: "Feature";
  properties: {
    key: string;
    origin: string;
    destination: string;
    flights: number;
    minPrice: number | null;
    minDuration: number | null;
    minStops: number | null;
  };
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
};

type PointFeature = {
  type: "Feature";
  properties: {
    code: string;
    role: "origin" | "destination" | "hub";
    routes: number;
  };
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
};

type FeatureCollection<T> = {
  type: "FeatureCollection";
  features: T[];
};

const restRange = (period: RestPeriod, config: FormatConfig) =>
  `${formatDate(period.start_date, config)} - ${formatDate(period.end_date, config)}`;

const buildRouteStats = (data: PipelineResult) => {
  const routes = new Map<string, RouteInfo>();

  const upsert = (origin: string, destination: string) => {
    const key = `${origin}-${destination}`;
    if (!routes.has(key)) {
      routes.set(key, {
        key,
        origin,
        destination,
        restPeriods: [],
        flightCount: 0,
        minPrice: null,
        minDuration: null,
        minStops: null
      });
    }
    return routes.get(key)!;
  };

  data.destinations.forEach((dest: DestinationSuggestion) => {
    dest.source_iata.forEach((origin) => {
      dest.destination_iatas.forEach((destination) => {
        const entry = upsert(origin, destination);
        entry.restPeriods.push(dest.rest_period);
      });
    });
  });

  data.flights.forEach((flight: FlightOption) => {
    const entry = upsert(flight.origin_iata, flight.destination_iata);
    entry.flightCount += 1;
    if (flight.price !== null) {
      entry.minPrice = entry.minPrice === null ? flight.price : Math.min(entry.minPrice, flight.price);
    }
    if (flight.total_duration_min !== null) {
      entry.minDuration =
        entry.minDuration === null ? flight.total_duration_min : Math.min(entry.minDuration, flight.total_duration_min);
    }
    if (flight.stops !== null) {
      entry.minStops = entry.minStops === null ? flight.stops : Math.min(entry.minStops, flight.stops);
    }
  });

  return routes;
};

const buildAirportInfo = (routes: RouteInfo[], airports: AirportCoordinates) => {
  const map = new Map<string, AirportInfo>();

  const upsert = (code: string, role: "origin" | "destination") => {
    const coordinates = airports[code];
    if (!coordinates) return;
    const existing = map.get(code);
    if (!existing) {
      map.set(code, { code, role, routeCount: 1, coordinates });
      return;
    }
    const combinedRole = existing.role === role ? existing.role : "hub";
    map.set(code, {
      ...existing,
      role: combinedRole,
      routeCount: existing.routeCount + 1
    });
  };

  routes.forEach((route) => {
    upsert(route.origin, "origin");
    upsert(route.destination, "destination");
  });

  return map;
};

export default function RoutesMap({ data, formatConfig }: { data: PipelineResult; formatConfig: FormatConfig }) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [airports, setAirports] = useState<AirportCoordinates | null>(null);
  const [airportsError, setAirportsError] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteInfo | null>(null);
  const [selectedAirport, setSelectedAirport] = useState<AirportInfo | null>(null);
  const routesRef = useRef<RouteInfo[]>([]);
  const airportsInfoRef = useRef<Map<string, AirportInfo>>(new Map());

  const routeStats = useMemo(() => buildRouteStats(data), [data]);
  const routes = useMemo(() => Array.from(routeStats.values()), [routeStats]);
  const airportsInfo = useMemo(() => {
    if (!airports) return new Map<string, AirportInfo>();
    return buildAirportInfo(routes, airports);
  }, [airports, routes]);

  useEffect(() => {
    routesRef.current = routes;
  }, [routes]);

  useEffect(() => {
    airportsInfoRef.current = airportsInfo;
  }, [airportsInfo]);

  const routesGeojson = useMemo(() => {
    if (!airports) return null;
    const features: LineFeature[] = [];
    routes.forEach((route) => {
      const originCoords = airports[route.origin];
      const destCoords = airports[route.destination];
      if (!originCoords || !destCoords) return;
      features.push({
        type: "Feature",
        properties: {
          key: route.key,
          origin: route.origin,
          destination: route.destination,
          flights: route.flightCount,
          minPrice: route.minPrice,
          minDuration: route.minDuration,
          minStops: route.minStops
        },
        geometry: {
          type: "LineString",
          coordinates: [originCoords, destCoords]
        }
      });
    });
    return { type: "FeatureCollection", features } satisfies FeatureCollection<LineFeature>;
  }, [airports, routes]);

  const airportsGeojson = useMemo(() => {
    if (!airports) return null;
    const features: PointFeature[] = [];
    airportsInfo.forEach((info) => {
      features.push({
        type: "Feature",
        properties: {
          code: info.code,
          role: info.role,
          routes: info.routeCount
        },
        geometry: {
          type: "Point",
          coordinates: info.coordinates
        }
      });
    });
    return { type: "FeatureCollection", features } satisfies FeatureCollection<PointFeature>;
  }, [airports, airportsInfo]);

  useEffect(() => {
    const loadAirports = async () => {
      try {
        const response = await fetch("/airports.json");
        if (!response.ok) {
          throw new Error("airports.json not found");
        }
        const payload = (await response.json()) as AirportCoordinates;
        setAirports(payload);
      } catch (err) {
        setAirportsError("Airport data is missing. Run `make map-data`.");
      }
    };
    loadAirports();
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [2.35, 48.86],
      zoom: 2.5
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !routesGeojson || !airportsGeojson) return;

    const map = mapRef.current;
    const routesSource = map.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    if (routesSource) {
      routesSource.setData(routesGeojson);
    } else {
      map.addSource("routes", {
        type: "geojson",
        data: routesGeojson
      });
      map.addLayer({
        id: "routes-layer",
        type: "line",
        source: "routes",
        paint: {
          "line-color": ORIGIN_COLOR,
          "line-width": 2.2,
          "line-opacity": 0.7
        }
      });
    }

    const airportsSource = map.getSource("airports") as maplibregl.GeoJSONSource | undefined;
    if (airportsSource) {
      airportsSource.setData(airportsGeojson);
    } else {
      map.addSource("airports", {
        type: "geojson",
        data: airportsGeojson
      });
      map.addLayer({
        id: "airports-layer",
        type: "circle",
        source: "airports",
        paint: {
          "circle-color": [
            "match",
            ["get", "role"],
            "origin",
            ORIGIN_COLOR,
            "destination",
            DEST_COLOR,
            "hub",
            HUB_COLOR,
            HUB_COLOR
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 5, 6, 7, 8],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff"
        }
      });
      map.addLayer({
        id: "airports-labels",
        type: "symbol",
        source: "airports",
        layout: {
          "text-field": ["get", "code"],
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top"
        },
        paint: {
          "text-color": "#1c252a"
        }
      });

      map.on("click", "routes-layer", (event) => {
        const feature = event.features?.[0];
        const key = feature?.properties?.key as string | undefined;
        if (!key) return;
        const match = routesRef.current.find((route) => route.key === key) || null;
        setSelectedRoute(match);
        setSelectedAirport(null);
      });

      map.on("click", "airports-layer", (event) => {
        const feature = event.features?.[0];
        const code = feature?.properties?.code as string | undefined;
        if (!code) return;
        const info = airportsInfoRef.current.get(code) || null;
        setSelectedAirport(info);
        setSelectedRoute(null);
      });

      map.on("mouseenter", "routes-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "routes-layer", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "airports-layer", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "airports-layer", () => {
        map.getCanvas().style.cursor = "";
      });
    }

    if (routesGeojson.features.length) {
      const bounds = new maplibregl.LngLatBounds();
      routesGeojson.features.forEach((feature) => {
        feature.geometry.coordinates.forEach((coord) => bounds.extend(coord));
      });
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding: 80, duration: 800 });
      }
    }
  }, [mapReady, routesGeojson, airportsGeojson, routes, airportsInfo]);

  const routeDetails = selectedRoute;
  const airportDetails = selectedAirport;

  return (
    <div className="map-grid">
      <div className="map-shell">
        <div ref={mapContainerRef} className="map-canvas" />
        <div className="map-legend">
          <span>
            <i className="legend-dot origin" /> Origins
          </span>
          <span>
            <i className="legend-dot dest" /> Destinations
          </span>
          <span>
            <i className="legend-line" /> Routes
          </span>
        </div>
        {airportsError && <div className="map-overlay">{airportsError}</div>}
        {!airportsError && !routesGeojson?.features.length && (
          <div className="map-overlay">No routes to display yet.</div>
        )}
      </div>
      <div className="map-info">
        <h4>Route insights</h4>
        {routeDetails ? (
          <div className="map-detail">
            <p className="muted">Selected route</p>
            <strong>
              {routeDetails.origin} → {routeDetails.destination}
            </strong>
            <div className="map-detail-grid">
              <div>
                <p className="muted">Best price</p>
                <strong>{formatCurrency(routeDetails.minPrice, formatConfig)}</strong>
              </div>
              <div>
                <p className="muted">Min duration</p>
                <strong>{formatDuration(routeDetails.minDuration)}</strong>
              </div>
              <div>
                <p className="muted">Stops</p>
                <strong>{routeDetails.minStops ?? "--"}</strong>
              </div>
              <div>
                <p className="muted">Flight options</p>
                <strong>{routeDetails.flightCount}</strong>
              </div>
            </div>
            <div>
              <p className="muted">Best rest windows</p>
              <ul>
                {routeDetails.restPeriods.slice(0, 3).map((period) => (
                  <li key={`${period.start_date}-${period.end_date}`}>{restRange(period, formatConfig)}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : airportDetails ? (
          <div className="map-detail">
            <p className="muted">Selected airport</p>
            <strong>{airportDetails.code}</strong>
            <div className="map-detail-grid">
              <div>
                <p className="muted">Role</p>
                <strong>{airportDetails.role}</strong>
              </div>
              <div>
                <p className="muted">Routes</p>
                <strong>{airportDetails.routeCount}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="map-detail">
            <p className="muted">Click a route or airport on the map.</p>
            <p>
              The map highlights origin hubs, destination clusters, and the most competitive routes based on price and
              duration.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
