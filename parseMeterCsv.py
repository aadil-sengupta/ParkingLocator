#!/usr/bin/env python3
"""
Build a structured per-time-slice parking meter schedule by joining
Meter_Operating_Schedules_* with Parking_Meters_* and writing a tidy CSV.

Usage:
  python build_meter_schedule.py Meter_Operating_Schedules_20251019.csv \
                                 Parking_Meters_20251019.csv \
                                 output_meter_schedule.csv \
                                 [--explode-days]

What it does:
  • Normalizes times to 24h (HH:MM)
  • Derives a human-friendly meter_state (e.g., "Tow-away", "Commercial Loading (metered)")
  • Parses time limits to integer minutes
  • Preserves the original day set (e.g., "Mo,Tu,We,Th,Fr"). If --explode-days is passed,
    it expands one row per weekday with a new "day" column (Monday..Sunday).
  • Joins in lat/lon, street name/num, and other useful columns from Parking_Meters

Output columns (base mode):
  post_id, street_name, street_num, street_and_block, block_side, cap_color,
  meter_state, schedule_type, applied_rule, priority, days, from_time, to_time,
  time_limit_min, active_meter_status, longitude, latitude, pm_district_id,
  blockface_id, analysis_neighborhood, supervisor_district, on_offstreet_type,
  meter_type, meter_vendor, meter_model, jurisdiction

Requires: pandas (pip install pandas)
"""

import argparse
import re
from datetime import datetime
from typing import Optional, List
import pandas as pd

DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
DAY_LONG = {
    "Mo": "Monday",
    "Tu": "Tuesday",
    "We": "Wednesday",
    "Th": "Thursday",
    "Fr": "Friday",
    "Sa": "Saturday",
    "Su": "Sunday",
}


def parse_time(s: Optional[str]) -> Optional[str]:
    """Parse a 12-hour time like '7:00 AM' -> '07:00'. Return None if empty."""
    if s is None:
        return None
    s = str(s).strip()
    if not s or s.lower() in {"nan", "none"}:
        return None
    # some inputs could be already 24h; try both
    for fmt in ("%I:%M %p", "%H:%M"):
        try:
            t = datetime.strptime(s, fmt)
            return t.strftime("%H:%M")
        except ValueError:
            continue
    # Last resort: try without minutes (e.g., '7 AM')
    for fmt in ("%I %p",):
        try:
            t = datetime.strptime(s, fmt)
            return t.strftime("%H:%M")
        except ValueError:
            pass
    return None


def parse_days(s: Optional[str]) -> List[str]:
    """Return normalized two-letter day abbreviations in canonical order."""
    if not s or str(s).strip().lower() in {"nan", "none"}:
        return []
    parts = [p.strip() for p in str(s).split(",") if p.strip()]
    parts = [p[:2].title() for p in parts]  # normalize case/length
    # Keep only valid abbreviations and preserve DAY_ORDER ordering
    uniq = []
    for d in DAY_ORDER:
        if d in parts:
            uniq.append(d)
    return uniq


def parse_time_limit_minutes(s: Optional[str]) -> Optional[int]:
    if s is None:
        return None
    m = re.search(r"(\d+)", str(s))
    return int(m.group(1)) if m else None


def derive_meter_state(schedule_type: str, applied_rule: Optional[str], cap_color: Optional[str]) -> str:
    st = (schedule_type or "").strip().lower()
    rule = (applied_rule or "").strip()
    rule_l = rule.lower()
    color = (cap_color or "").strip()

    if "tow" in st:
        return "Tow-away"
    if "operating" in st or "operate" in st:
        if "commercial" in rule_l:
            return "Commercial Loading (metered)"
        if "general metered" in rule_l or "general" in rule_l:
            return "General Metered"
        if rule:
            return rule
        return "Metered"
    if "alternate" in st:
        return f"Alternate: {rule or color or 'Rule'}"
    # fallback
    return (schedule_type or rule or color or "Schedule").strip()


def clean_columns(df: pd.DataFrame) -> pd.DataFrame:
    # Strip whitespace from headers and cell values
    df = df.rename(columns={c: c.strip() for c in df.columns})
    return df.applymap(lambda x: x.strip() if isinstance(x, str) else x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("schedule_csv", help="Meter_Operating_Schedules_*.csv")
    ap.add_argument("meters_csv", help="Parking_Meters_*.csv")
    ap.add_argument("output_csv", help="Path to write the structured CSV")
    ap.add_argument("--explode-days", action="store_true", help="Expand one row per day with a 'day' column")
    args = ap.parse_args()

    # Load
    sched = pd.read_csv(args.schedule_csv, dtype=str, keep_default_na=False)
    meters = pd.read_csv(args.meters_csv, dtype=str, keep_default_na=False)

    sched = clean_columns(sched)
    meters = clean_columns(meters)

    # Expected schedule columns
    col_map = {
        "Post ID": "post_id",
        "Street and Block": "street_and_block",
        "Block Side": "block_side",
        "Cap Color": "cap_color_sched",
        "Schedule Type": "schedule_type",
        "Applied Color Rule": "applied_rule",
        "Priority": "priority",
        "Days Applied": "days",
        "From Time": "from_time_raw",
        "To Time": "to_time_raw",
        "Active Meter Status": "active_meter_status",
        "Time Limit": "time_limit_raw",
    }
    missing = [k for k in col_map if k not in sched.columns]
    if missing:
        raise SystemExit(f"Missing columns in schedule CSV: {missing}")

    s = sched.rename(columns=col_map).copy()

    # Normalize
    s["from_time"] = s.pop("from_time_raw").apply(parse_time)
    s["to_time"] = s.pop("to_time_raw").apply(parse_time)
    s["priority"] = s["priority"].apply(lambda x: int(re.search(r"\d+", x).group(0)) if re.search(r"\d+", str(x)) else None)
    s["time_limit_min"] = s.pop("time_limit_raw").apply(parse_time_limit_minutes)

    # Clean applied_rule "-" noise
    s["applied_rule"] = s["applied_rule"].apply(lambda x: None if (not x or x.strip(" -") == "") else x)

    # Derive state
    s["meter_state"] = s.apply(
        lambda r: derive_meter_state(r.get("schedule_type"), r.get("applied_rule"), r.get("cap_color_sched")),
        axis=1,
    )

    # Standardize days for sorting; keep original string too
    s["days_norm"] = s["days"].apply(parse_days)

    # Prepare meters subset for merge
    keep_cols = {
        "POST_ID": "post_id",
        "STREET_NAME": "street_name",
        "STREET_NUM": "street_num",
        "ORIENTATION": "orientation",
        "LONGITUDE": "longitude",
        "LATITUDE": "latitude",
        "JURISDICTION": "jurisdiction",
        "PM_DISTRICT_ID": "pm_district_id",
        "BLOCKFACE_ID": "blockface_id",
        "ACTIVE_METER_FLAG": "active_meter_flag",
        "REASON_CODE": "reason_code",
        "SMART_METER_FLAG": "smart_meter_flag",
        "METER_TYPE": "meter_type",
        "METER_VENDOR": "meter_vendor",
        "METER_MODEL": "meter_model",
        "CAP_COLOR": "cap_color_meters",
        "analysis_neighborhood": "analysis_neighborhood",
        "supervisor_district": "supervisor_district",
        "ON_OFFSTREET_TYPE": "on_offstreet_type",
        "PMR_ROUTE": "pmr_route",
        "COLLECTION_ROUTE": "collection_route",
        "COLLECTION_SUBROUTE": "collection_subroute",
        "COLLECTION_ROUTE_DESC": "collection_route_desc",
        "COLLECTION_SUBROUTE_DESC": "collection_subroute_desc",
    }

    missing_m = [k for k in keep_cols if k not in meters.columns]
    # Don't hard fail; keep what's present.
    m = meters.rename(columns={k: keep_cols.get(k, k) for k in meters.columns}).copy()

    # Select only columns we mapped (if present)
    m = m[[v for v in keep_cols.values() if v in m.columns]].copy()

    # Merge
    out = s.merge(m, on="post_id", how="left", validate="m:1")

    # Consolidate cap_color (prefer meter table, else schedule)
    if "cap_color_meters" in out.columns:
        out["cap_color"] = out["cap_color_meters"].where(out["cap_color_meters"].notna() & (out["cap_color_meters"].astype(str).str.len() > 0), out.get("cap_color_sched"))
    else:
        out["cap_color"] = out.get("cap_color_sched")

    # Final column order
    desired_cols = [
        "post_id",
        "street_name",
        "street_num",
        "street_and_block",
        "block_side",
        "cap_color",
        "meter_state",
        "schedule_type",
        "applied_rule",
        "priority",
        "days",
        "from_time",
        "to_time",
        "time_limit_min",
        "active_meter_status",
        "longitude",
        "latitude",
        "pm_district_id",
        "blockface_id",
        "analysis_neighborhood",
        "supervisor_district",
        "on_offstreet_type",
        "meter_type",
        "meter_vendor",
        "meter_model",
        "jurisdiction",
    ]

    # Keep only columns that exist
    final_cols = [c for c in desired_cols if c in out.columns]
    out = out[final_cols].copy()

    # Sort for readability
    out = out.sort_values(by=["post_id", "priority", "from_time", "to_time"], na_position="last")

    if args.explode_days:
        # Expand to one row per day with a new 'day' column (long name)
        out["days_list"] = out["days"].apply(parse_days)
        out = out.explode("days_list", ignore_index=True)
        out["day"] = out["days_list"].map(DAY_LONG).fillna("")
        out.drop(columns=["days_list"], inplace=True)
        # Optional: reorder to put 'day' next to 'days'
        cols = out.columns.tolist()
        if "day" in cols and "days" in cols:
            cols.insert(cols.index("days") + 1, cols.pop(cols.index("day")))
            out = out[cols]

    # Write CSV
    out.to_csv(args.output_csv, index=False)

    # Simple summary
    total_rows = len(out)
    unique_posts = out["post_id"].nunique(dropna=True) if "post_id" in out.columns else "?"
    print(f"Wrote {total_rows} rows for {unique_posts} unique post_id(s) -> {args.output_csv}")


if __name__ == "__main__":
    main()
