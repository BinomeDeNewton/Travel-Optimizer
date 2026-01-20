export type CountryIdentity = {
  name: string;
  code: string | null;
};

export type ItineraryStop = {
  country: CountryIdentity;
  days: number;
};

export type ItinerarySuggestion = {
  id: string;
  title: string;
  stops: ItineraryStop[];
  travelDays: number;
  totalDays: number;
};

export type ItineraryCategory = {
  key: string;
  labelKey: string;
  descriptionKey: string;
  suggestions: ItinerarySuggestion[];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const distributeDays = (total: number, parts: number) => {
  const count = Math.max(parts, 1);
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
};

const combinations = <T,>(items: T[], size: number, start = 0): T[][] => {
  if (size === 0) return [[]];
  const result: T[][] = [];
  for (let i = start; i <= items.length - size; i += 1) {
    const head = items[i];
    const tailCombos = combinations(items, size - 1, i + 1);
    tailCombos.forEach((combo) => result.push([head, ...combo]));
  }
  return result;
};

const uniqueCountries = (items: CountryIdentity[]) => {
  const map = new Map<string, CountryIdentity>();
  items.forEach((item) => {
    if (!map.has(item.name)) {
      map.set(item.name, item);
    }
  });
  return Array.from(map.values());
};

export const buildChaslesItineraries = (options: {
  destinations: CountryIdentity[];
  minDays: number;
  maxDays: number;
  maxPerCategory?: number;
}) => {
  const destinations = uniqueCountries(options.destinations);
  if (!destinations.length) return [] as ItineraryCategory[];

  const targetDays = Math.max(3, Math.round((options.minDays + options.maxDays) / 2));
  const maxStops = targetDays <= 5 ? 1 : targetDays <= 10 ? 2 : 3;
  const maxPerCategory = clamp(options.maxPerCategory ?? 4, 1, 6);

  const categories = [
    {
      key: "direct",
      labelKey: "itinerary.category.direct.label",
      descriptionKey: "itinerary.category.direct.description",
      stops: 1
    },
    {
      key: "chain",
      labelKey: "itinerary.category.chain.label",
      descriptionKey: "itinerary.category.chain.description",
      stops: 2
    },
    {
      key: "loop",
      labelKey: "itinerary.category.loop.label",
      descriptionKey: "itinerary.category.loop.description",
      stops: 3
    }
  ];

  return categories
    .filter((category) => category.stops <= maxStops && category.stops <= destinations.length)
    .map((category) => {
      const combos = combinations(destinations, category.stops).slice(0, maxPerCategory);
      const suggestions = combos.map((combo) => {
        const travelDays = combo.length + 1;
        const minStay = combo.length;
        const totalDays = Math.max(targetDays, travelDays + minStay);
        const stayDays = Math.max(minStay, totalDays - travelDays);
        const daysPerStop = distributeDays(stayDays, combo.length);

        const stops: ItineraryStop[] = combo.map((country, index) => ({
          country,
          days: daysPerStop[index] ?? 1
        }));

        return {
          id: `${category.key}-${combo.map((item) => item.name).join("-")}`,
          title: combo.map((item) => item.name).join(" + "),
          stops,
          travelDays,
          totalDays
        };
      });

      return {
        key: category.key,
        labelKey: category.labelKey,
        descriptionKey: category.descriptionKey,
        suggestions
      };
    })
    .filter((category) => category.suggestions.length);
};
