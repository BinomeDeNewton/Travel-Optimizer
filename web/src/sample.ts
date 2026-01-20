import type { PipelineResult } from "./types";

export const sampleData: PipelineResult = {
  timeoff: {
    rest_periods: [
      { start_date: "2025-04-19", end_date: "2025-05-11", days: 23 },
      { start_date: "2025-05-24", end_date: "2025-05-27", days: 4 },
      { start_date: "2025-06-07", end_date: "2025-06-15", days: 9 }
    ],
    total_rest_days: 74,
    used_leave_days: 25,
    unused_leave_days: 0,
    score: 96.4,
    best_month: {
      month: 5,
      leave_days: 7,
      rest_days: 14,
      efficiency: 2.0
    },
    efficiency_ranking: [
      { month: 5, leave_days: 7, rest_days: 14, efficiency: 2.0 },
      { month: 4, leave_days: 8, rest_days: 14, efficiency: 1.75 },
      { month: 6, leave_days: 5, rest_days: 8, efficiency: 1.6 }
    ]
  },
  destinations: [
    {
      rest_period: { start_date: "2025-04-19", end_date: "2025-05-11", days: 23 },
      country: "Japan",
      country_code: "JP",
      cities: ["Tokyo", "Kyoto"],
      source_iata: ["CDG"],
      destination_iatas: ["HND", "KIX"],
      flight_hours: 12.1,
      haul_category: "long",
      climate: {
        avg_temp_c: 16.8,
        precip_mm: 110.2,
        months: [4, 5],
        source: "open-meteo-archive",
        source_year: 2023
      },
      safety: {
        level: "Low",
        score: 1.2,
        message: "Exercise normal precautions",
        updated: "2024-05-01",
        source: "travel-advisory.info"
      }
    },
    {
      rest_period: { start_date: "2025-05-24", end_date: "2025-05-27", days: 4 },
      country: "Italy",
      country_code: "IT",
      cities: ["Venice"],
      source_iata: ["CDG"],
      destination_iatas: ["VCE"],
      flight_hours: 1.5,
      haul_category: "short",
      climate: {
        avg_temp_c: 21.3,
        precip_mm: 58.4,
        months: [5],
        source: "open-meteo-archive",
        source_year: 2023
      },
      safety: {
        level: "Low",
        score: 1.3,
        message: "Exercise normal precautions",
        updated: "2024-05-01",
        source: "travel-advisory.info"
      }
    }
  ],
  flights: [
    {
      origin_iata: "CDG",
      destination_iata: "HND",
      depart_date: "2025-04-19",
      return_date: "2025-05-11",
      price: 785,
      total_duration_min: 910,
      stops: 1,
      score: 88.2,
      provider: "flight_planner"
    },
    {
      origin_iata: "CDG",
      destination_iata: "VCE",
      depart_date: "2025-05-24",
      return_date: "2025-05-27",
      price: 210,
      total_duration_min: 145,
      stops: 0,
      score: 92.5,
      provider: "flight_planner"
    }
  ],
  lodging: [
    {
      name: "Yuragi House",
      price_total: 980,
      rating: 4.6,
      location: "Tokyo",
      score: 89.0
    },
    {
      name: "Lagoon Loft",
      price_total: 420,
      rating: 4.3,
      location: "Venice",
      score: 84.0
    }
  ],
  itineraries: [
    {
      rest_period: { start_date: "2025-04-19", end_date: "2025-05-11", days: 23 },
      destination: {
        rest_period: { start_date: "2025-04-19", end_date: "2025-05-11", days: 23 },
        country: "Japan",
        country_code: "JP",
        cities: ["Tokyo", "Kyoto"],
        source_iata: ["CDG"],
        destination_iatas: ["HND", "KIX"],
        flight_hours: 12.1,
        haul_category: "long",
        climate: {
          avg_temp_c: 16.8,
          precip_mm: 110.2,
          months: [4, 5],
          source: "open-meteo-archive",
          source_year: 2023
        },
        safety: {
          level: "Low",
          score: 1.2,
          message: "Exercise normal precautions",
          updated: "2024-05-01",
          source: "travel-advisory.info"
        }
      },
      flights: [
        {
          origin_iata: "CDG",
          destination_iata: "HND",
          depart_date: "2025-04-19",
          return_date: "2025-05-11",
          price: 785,
          total_duration_min: 910,
          stops: 1,
          score: 88.2,
          provider: "flight_planner"
        }
      ],
      lodging: [
        {
          name: "Yuragi House",
          price_total: 980,
          rating: 4.6,
          location: "Tokyo",
          score: 89.0
        }
      ],
      notes: "Longest rest window with the best score."
    }
  ]
};
