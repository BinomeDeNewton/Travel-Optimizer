import { useMemo } from "react";
import type { RestPeriod, TimeoffDay } from "../types";
import { parseISODate } from "../utils/format";

const pad = (value: number) => String(value).padStart(2, "0");

const toDateKey = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

const periodKey = (period: RestPeriod) => `${period.start_date}|${period.end_date}`;

const buildPeriodMap = (periods: RestPeriod[]) => {
  const map = new Map<string, string>();
  periods.forEach((period) => {
    const key = periodKey(period);
    const start = parseISODate(period.start_date);
    const end = parseISODate(period.end_date);
    const cursor = new Date(start);
    while (cursor <= end) {
      const dayKey = cursor.toISOString().slice(0, 10);
      map.set(dayKey, key);
      cursor.setDate(cursor.getDate() + 1);
    }
  });
  return map;
};

type CalendarCell = {
  date: string;
  day: number;
  info: TimeoffDay | null;
  period: string | null;
};

type CalendarMonth = {
  name: string;
  year: number;
  cells: Array<CalendarCell | null>;
};

type TimeoffCalendarProps = {
  days?: TimeoffDay[];
  restPeriods: RestPeriod[];
  activePeriodKey: string | null;
  selectedPeriodKey: string | null;
  onHover: (key: string | null) => void;
  onSelect: (key: string | null) => void;
  locale: string;
  timeZone: string;
};

export default function TimeoffCalendar({
  days,
  restPeriods,
  activePeriodKey,
  selectedPeriodKey,
  onHover,
  onSelect,
  locale,
  timeZone
}: TimeoffCalendarProps) {
  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone });
    const base = new Date(Date.UTC(2024, 0, 1, 12, 0, 0));
    return Array.from({ length: 7 }, (_, index) =>
      formatter.format(new Date(Date.UTC(2024, 0, base.getUTCDate() + index, 12, 0, 0)))
    );
  }, [locale, timeZone]);

  const monthLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { month: "long", timeZone });
    return Array.from({ length: 12 }, (_, index) =>
      formatter.format(new Date(Date.UTC(2024, index, 1, 12, 0, 0)))
    );
  }, [locale, timeZone]);

  const dayMap = useMemo(() => {
    if (!days?.length) return new Map<string, TimeoffDay>();
    return new Map(days.map((day) => [day.date, day]));
  }, [days]);

  const calendarYear = useMemo(() => {
    if (days?.length) {
      return parseISODate(days[0].date).getUTCFullYear();
    }
    if (restPeriods.length) {
      return parseISODate(restPeriods[0].start_date).getUTCFullYear();
    }
    return new Date().getFullYear();
  }, [days, restPeriods]);

  const periodMap = useMemo(() => buildPeriodMap(restPeriods), [restPeriods]);

  const months = useMemo<CalendarMonth[]>(() => {
    const result: CalendarMonth[] = [];
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const firstDay = new Date(calendarYear, monthIndex, 1);
      const firstWeekday = (firstDay.getDay() + 6) % 7;
      const daysInMonth = new Date(calendarYear, monthIndex + 1, 0).getDate();
      const cells: Array<CalendarCell | null> = [];
      for (let i = 0; i < firstWeekday; i += 1) {
        cells.push(null);
      }
      for (let day = 1; day <= daysInMonth; day += 1) {
        const dateKey = toDateKey(calendarYear, monthIndex + 1, day);
        cells.push({
          date: dateKey,
          day,
          info: dayMap.get(dateKey) ?? null,
          period: periodMap.get(dateKey) ?? null
        });
      }
      result.push({
        name: monthLabels[monthIndex],
        year: calendarYear,
        cells
      });
    }
    return result;
  }, [calendarYear, dayMap, monthLabels, periodMap]);

  if (!days?.length) {
    return (
      <div className="calendar-empty">
        <h3>Calendar data missing</h3>
        <p>Run the optimizer to generate a day-by-day calendar with holidays and optimized leave.</p>
      </div>
    );
  }

  return (
    <div className="calendar-grid">
      {months.map((month) => (
        <div key={month.name} className="calendar-month">
          <div className="calendar-month-header">
            <span>{month.name}</span>
            <span className="muted">{month.year}</span>
          </div>
          <div className="calendar-weekdays">
            {weekdays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-days" onMouseLeave={() => onHover(null)}>
            {month.cells.map((cell, index) => {
              if (!cell) {
                return <span key={`empty-${month.name}-${index}`} className="calendar-day empty" />;
              }
              const baseKind = cell.info?.base_kind ?? "WORK";
              const leaveKind = cell.info?.leave ?? "NONE";
              const baseClass = `base-${baseKind.toLowerCase()}`;
              const leaveClass = leaveKind !== "NONE" ? `leave-${leaveKind.toLowerCase()}` : "";
              const periodClass = cell.period ? "in-period" : "";
              const activeClass = cell.period && cell.period === activePeriodKey ? "active" : "";
              const selectedClass = cell.period && cell.period === selectedPeriodKey ? "selected" : "";
              const imposedClass = cell.info?.imposed ? "imposed" : "";
              const lockedClass = cell.info?.locked ? "locked" : "";
              const labelParts = [
                cell.date,
                baseKind.toLowerCase(),
                leaveKind !== "NONE" ? `leave ${leaveKind.toLowerCase()}` : ""
              ].filter(Boolean);
              const tooltip = cell.info?.reason ?? "";
              return (
                <button
                  key={cell.date}
                  type="button"
                  className={`calendar-day ${baseClass} ${leaveClass} ${periodClass} ${activeClass} ${selectedClass} ${lockedClass} ${imposedClass}`}
                  onMouseEnter={() => onHover(cell.period)}
                  onClick={() => {
                    if (cell.period) {
                      onSelect(cell.period);
                    }
                  }}
                  aria-label={labelParts.join(" ")}
                  data-tooltip={tooltip || undefined}
                >
                  <span>{cell.day}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
