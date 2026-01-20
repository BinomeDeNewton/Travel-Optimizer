export type FormatConfig = {
  locale: string;
  timeZone: string;
  currency: string;
};

const pad = (value: number) => String(value).padStart(2, "0");

export const toDateInputValue = (value: Date) =>
  `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;

export const parseISODate = (value: string) => {
  const parts = value.split("-");
  if (parts.length >= 3) {
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
      return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    }
  }
  return new Date(value);
};

export const formatDate = (value: string, config: FormatConfig) => {
  const date = parseISODate(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(config.locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: config.timeZone
  }).format(date);
};

export const formatDateTime = (value: string | null, config: FormatConfig) => {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(config.locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: config.timeZone
  }).format(date);
};

export const formatJobTimestamp = (value: number | null | undefined, config: FormatConfig) => {
  if (!value) return "--";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(config.locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: config.timeZone
  }).format(date);
};

export const formatCurrency = (value: number | null, config: FormatConfig, currency?: string) => {
  if (value === null || Number.isNaN(value)) return "--";
  const unit = currency ?? config.currency;
  return new Intl.NumberFormat(config.locale, {
    style: "currency",
    currency: unit,
    maximumFractionDigits: 0
  }).format(value);
};

export const formatDuration = (minutes: number | null) => {
  if (!minutes) return "--";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
};

export const formatMonths = (months: number[] | null | undefined, config: FormatConfig) => {
  if (!months?.length) return "";
  const formatter = new Intl.DateTimeFormat(config.locale, { month: "short", timeZone: config.timeZone });
  return months
    .map((month) => {
      if (month < 1 || month > 12) return String(month);
      const date = new Date(Date.UTC(2024, month - 1, 1, 12, 0, 0));
      return formatter.format(date);
    })
    .join(", ");
};
