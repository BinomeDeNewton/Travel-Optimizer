"""Timeoff optimization engine."""

from __future__ import annotations

from collections import Counter
from dataclasses import replace
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional, Set, Tuple

from travel_optimizer.core.models import BaseDayKind, DayInfo, LeaveKind, RestPeriod, TimeoffRequest, TimeoffResult
from travel_optimizer.modules.timeoff.holidays import holiday_dates, normalize_country_input

DayMap = Dict[date, DayInfo]


def build_base_calendar(
    year: int,
    holiday_dates: Optional[Set[date]] = None,
    company_closure_dates: Optional[Set[date]] = None,
) -> DayMap:
    holiday_dates = holiday_dates or set()
    company_closure_dates = company_closure_dates or set()

    day_map: DayMap = {}
    d = date(year, 1, 1)
    while d.year == year:
        if d in company_closure_dates:
            base = BaseDayKind.COMPANY_CLOSURE
        elif d.weekday() >= 5:
            base = BaseDayKind.WEEKEND
        elif d in holiday_dates:
            base = BaseDayKind.HOLIDAY
        else:
            base = BaseDayKind.WORKDAY
        day_map[d] = DayInfo(date=d, base_kind=base)
        d += timedelta(days=1)
    return day_map


def is_rest_day(info: DayInfo) -> bool:
    if info.base_kind in (BaseDayKind.WEEKEND, BaseDayKind.HOLIDAY, BaseDayKind.COMPANY_CLOSURE):
        return True
    return info.leave not in (LeaveKind.NONE,)


def apply_preassigned(
    day_map: DayMap,
    forced_vacation_dates: Iterable[date],
    locked_cp_dates: Iterable[date],
    locked_rtt_dates: Iterable[date],
    locked_recup_dates: Iterable[date],
    soft_day_dates: Iterable[date],
) -> None:
    def _mark(dates: Iterable[date], leave_kind: LeaveKind, imposed: bool = False) -> None:
        for d in dates:
            if d in day_map:
                info = day_map[d]
                info.leave = leave_kind
                info.locked = True
                info.imposed = imposed

    _mark(forced_vacation_dates, LeaveKind.PAID, imposed=True)
    _mark(locked_cp_dates, LeaveKind.PAID)
    _mark(locked_rtt_dates, LeaveKind.RTT)
    _mark(locked_recup_dates, LeaveKind.RECUP)

    for d in soft_day_dates:
        if d in day_map:
            info = day_map[d]
            info.leave = LeaveKind.SOFT
            info.locked = True


def clone_day_map(day_map: DayMap) -> DayMap:
    return {d: replace(info) for d, info in day_map.items()}


def count_preassigned_leaves(day_map: DayMap) -> Counter:
    counter: Counter = Counter()
    for info in day_map.values():
        if info.leave in (LeaveKind.PAID, LeaveKind.RTT, LeaveKind.RECUP):
            counter[info.leave] += 1
    return counter


def optimize_leaves_classic(day_map: DayMap, year: int, total_leave_days: int) -> DayMap:
    if total_leave_days <= 0:
        return day_map

    used_counter = count_preassigned_leaves(day_map)
    already_used = used_counter.get(LeaveKind.PAID, 0)
    remaining = max(0, total_leave_days - already_used)
    if remaining <= 0:
        return day_map

    base_month_limit = max(1, total_leave_days // 4 + 1)

    month_usage = {m: 0 for m in range(1, 13)}
    for info in day_map.values():
        if info.leave == LeaveKind.PAID:
            month_usage[info.date.month] += 1

    month_limits = {m: max(base_month_limit, month_usage[m]) for m in range(1, 13)}

    def can_take(target: date) -> bool:
        if remaining <= 0:
            return False
        info = day_map.get(target)
        if not info:
            return False
        if info.base_kind != BaseDayKind.WORKDAY:
            return False
        if info.locked or info.leave != LeaveKind.NONE:
            return False
        month = target.month
        if month_usage[month] >= month_limits[month]:
            return False
        return True

    def take_if_possible(target: date) -> bool:
        nonlocal remaining
        if not can_take(target):
            return False
        info = day_map[target]
        info.leave = LeaveKind.PAID
        month_usage[target.month] += 1
        remaining -= 1
        return True

    def handle_monday_bridge(holiday: date) -> None:
        for offset in range(1, 5):
            take_if_possible(holiday + timedelta(days=offset))

    def handle_thursday_bridge(holiday: date) -> None:
        for offset in (-3, -2, -1, 1):
            take_if_possible(holiday + timedelta(days=offset))

    holidays_by_month = {m: [] for m in range(1, 13)}
    for d, info in day_map.items():
        if info.base_kind == BaseDayKind.HOLIDAY:
            holidays_by_month[d.month].append(d)

    for month in range(1, 13):
        holidays_by_month[month].sort()
        for holiday in holidays_by_month[month]:
            weekday = holiday.weekday()
            if weekday == 0:
                handle_monday_bridge(holiday)
            elif weekday == 3:
                handle_thursday_bridge(holiday)

            if remaining <= 0 or month_usage[month] >= month_limits[month]:
                break

    xmas = date(year, 12, 25)
    if xmas.weekday() == 2:
        take_if_possible(xmas + timedelta(days=1))
        take_if_possible(xmas + timedelta(days=2))

    return day_map


def find_rest_periods(day_map: DayMap, min_length: int = 3) -> Tuple[List[RestPeriod], int]:
    ordered_dates = sorted(day_map.keys())
    periods: List[RestPeriod] = []
    total_rest_days = 0
    current_segment: List[date] = []

    for d in ordered_dates:
        if is_rest_day(day_map[d]):
            total_rest_days += 1
            if not current_segment:
                current_segment = [d]
            elif (d - current_segment[-1]).days == 1:
                current_segment.append(d)
            else:
                if len(current_segment) >= min_length:
                    periods.append(RestPeriod(current_segment[0], current_segment[-1]))
                current_segment = [d]
        else:
            if current_segment and len(current_segment) >= min_length:
                periods.append(RestPeriod(current_segment[0], current_segment[-1]))
            current_segment = []

    if current_segment and len(current_segment) >= min_length:
        periods.append(RestPeriod(current_segment[0], current_segment[-1]))

    return periods, total_rest_days


def rest_days_by_month(day_map: DayMap) -> Dict[int, int]:
    res = {m: 0 for m in range(1, 13)}
    for d, info in day_map.items():
        if is_rest_day(info):
            res[d.month] += 1
    return res


def cheapest_month_for_vacation(day_map: DayMap) -> Tuple[Optional[dict], List[dict]]:
    rest_by_month = rest_days_by_month(day_map)
    per_month: List[dict] = []
    for month in range(1, 13):
        leave_days = sum(
            1
            for info in day_map.values()
            if info.date.month == month and info.leave == LeaveKind.PAID
        )
        rest_days = rest_by_month[month]
        efficiency = rest_days / leave_days if leave_days else 0.0
        per_month.append(
            {
                "month": month,
                "leave_days": leave_days,
                "rest_days": rest_days,
                "efficiency": efficiency,
            }
        )

    ranked = sorted(per_month, key=lambda item: (item["efficiency"], item["rest_days"]), reverse=True)
    best = next((item for item in ranked if item["leave_days"] > 0), None)
    return best, ranked


def compute_score(day_map: DayMap) -> float:
    ordered_dates = sorted(day_map.keys())
    total_rest = 0
    long_breaks: List[int] = []
    current_segment: List[date] = []

    for d in ordered_dates:
        info = day_map[d]
        if is_rest_day(info):
            total_rest += 1
            if not current_segment:
                current_segment = [d]
            elif (d - current_segment[-1]).days == 1:
                current_segment.append(d)
            else:
                long_breaks.append(len(current_segment))
                current_segment = [d]
        else:
            if current_segment:
                long_breaks.append(len(current_segment))
                current_segment = []

    if current_segment:
        long_breaks.append(len(current_segment))

    long_break_bonus = sum(max(0, length - 2) for length in long_breaks)

    paid_leave = sum(1 for info in day_map.values() if info.leave == LeaveKind.PAID)
    efficiency_bonus = 0.0
    if paid_leave > 0:
        efficiency_bonus = (total_rest / paid_leave) * 5.0

    return float(total_rest) + long_break_bonus + efficiency_bonus


def optimize_timeoff(request: TimeoffRequest) -> TimeoffResult:
    country_code, subdivision_code = normalize_country_input(
        request.country_code,
        request.subdivision_code,
    )
    holidays = holiday_dates(request.year, country_code, subdivision_code)
    base_day_map = build_base_calendar(
        request.year,
        holiday_dates=holidays,
        company_closure_dates=set(request.company_closure_dates),
    )
    apply_preassigned(
        base_day_map,
        forced_vacation_dates=set(request.company_closure_dates),
        locked_cp_dates=set(request.locked_cp_dates),
        locked_rtt_dates=set(request.locked_rtt_dates),
        locked_recup_dates=set(request.locked_recup_dates),
        soft_day_dates=set(request.soft_day_dates),
    )

    dm = clone_day_map(base_day_map)
    optimize_leaves_classic(dm, year=request.year, total_leave_days=request.total_leave_days)

    periods, total_rest = find_rest_periods(dm, request.min_rest_length)
    score = compute_score(dm)
    used_cp = sum(1 for info in dm.values() if info.leave == LeaveKind.PAID)
    best_month, efficiency_ranking = cheapest_month_for_vacation(dm)

    return TimeoffResult(
        day_map=dm,
        rest_periods=periods,
        total_rest_days=total_rest,
        used_leave_days=used_cp,
        unused_leave_days=max(0, request.total_leave_days - used_cp),
        score=score,
        best_month=best_month,
        efficiency_ranking=efficiency_ranking,
        country_code=country_code,
        subdivision_code=subdivision_code,
    )
