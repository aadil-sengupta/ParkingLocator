#!/usr/bin/env python3
"""
Cluster (club) nearby parking meters that share the same operating schedule.

Input:
  A tidy CSV like the 'output.csv' you generated earlier, containing (at least):
    - post_id
    - longitude, latitude
    - days, from_time, to_time, time_limit_min
    - meter_state (and/or schedule_type + applied_rule)
    - Optional extras: cap_color, blockface_id, street_name, street_num, etc.

Output:
  Two CSVs:
    1) clusters_csv: One row per spatial cluster of meters with the SAME schedule.
    2) members_csv:  One row per meter, mapped to its cluster_id.

Usage:
  python cluster_meters.py output.csv clusters.csv members.csv \
         --radius-m 20

Notes:
  - "Same schedule" is defined by a canonical signature built from each meter's
    set of (days, from_time, to_time, time_limit_min, meter_state, schedule_type, applied_rule, cap_color).
    You can adjust the signature fields with --signature-fields if needed.
  - Spatial clustering uses DBSCAN with haversine distance if scikit-learn is available.
    Otherwise, it falls back to a simple O(N^2) union-find within each schedule group.
  - The default radius is 20 meters. Adjust with --radius-m to be more or less strict.
"""

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import pandas as pd

EARTH_RADIUS_M = 6371000.0

DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
DAY_MAP_LONG2ABBR = {
    "monday": "Mo", "tuesday": "Tu", "wednesday": "We",
    "thursday": "Th", "friday": "Fr", "saturday": "Sa", "sunday": "Su",
}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters between two WGS84 points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def norm_time(t: Optional[str]) -> str:
    """Normalize times like '7:00 AM' or '07:00' to 'HH:MM'. Unknown -> ''."""
    if t is None:
        return ""
    s = str(t).strip()
    if not s or s.lower() in {"nan", "none"}:
        return ""
    # Try 24h first
    try:
        hh, mm = s.split(":")
        hh = int(hh)
        if "am" in s.lower() or "pm" in s.lower():
            raise ValueError  # handled below
        # guard
        if 0 <= hh <= 23:
            return f"{hh:02d}:{int(mm):02d}"
    except Exception:
        pass
    # Try 12h clock
    import datetime as _dt
    for fmt in ("%I:%M %p", "%I %p"):
        try:
            dt = _dt.datetime.strptime(s, fmt)
            return dt.strftime("%H:%M")
        except ValueError:
            continue
    # Give up
    return s


def canonical_days(days_str: Optional[str], fallback_day_long: Optional[str] = None) -> str:
    """
    Normalize a 'days' value like 'Mo,Tu,We,Th,Fr' to a canonical, ordered string.
    If days_str is empty but a single-day (long name) is provided, use that.
    """
    if days_str and str(days_str).strip():
        parts = [p.strip() for p in str(days_str).split(",") if p.strip()]
        abbr = []
        seen = set()
        for d in DAY_ORDER:
            if d in parts and d not in seen:
                abbr.append(d); seen.add(d)
        # Include any other tokens (already abbreviated?) that weren't in DAY_ORDER
        for p in parts:
            if p not in seen and len(p) <= 3:
                abbr.append(p)
        return ",".join(abbr)
    if fallback_day_long and str(fallback_day_long).strip():
        abbr = DAY_MAP_LONG2ABBR.get(str(fallback_day_long).strip().lower())
        return abbr or ""
    return ""


def build_schedule_signature(meter_df: pd.DataFrame,
                             fields: Sequence[str]) -> Tuple[str, List[Dict[str, str]]]:
    """
    From all rows for one meter (post_id), create a canonical set of schedule entries,
    then return a (hash, pretty_entries) pair.
    """
    entries: List[Dict[str, str]] = []
    for _, r in meter_df.iterrows():
        # Handle days normalization; support either 'days' or 'day'
        days = canonical_days(r.get("days"), r.get("day"))
        rec = {}
        for f in fields:
            if f == "days":
                rec["days"] = days
            elif f == "from_time":
                rec["from_time"] = norm_time(r.get("from_time"))
            elif f == "to_time":
                rec["to_time"] = norm_time(r.get("to_time"))
            else:
                v = r.get(f)
                rec[f] = "" if v is None else str(v)
        entries.append(rec)

    # Deduplicate identical entries then sort stably for deterministic hash
    uniq = {json.dumps(e, sort_keys=True) for e in entries}
    entries_sorted = [json.loads(s) for s in sorted(uniq)]
    raw = json.dumps(entries_sorted, sort_keys=True, ensure_ascii=False)
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()
    return h, entries_sorted


class UnionFind:
    def __init__(self, n: int):
        self.p = list(range(n))
        self.r = [0]*n
    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x
    def union(self, a: int, b: int):
        ra, rb = self.find(a), self.find(b)
        if ra == rb: return
        if self.r[ra] < self.r[rb]:
            self.p[ra] = rb
        elif self.r[ra] > self.r[rb]:
            self.p[rb] = ra
        else:
            self.p[rb] = ra
            self.r[ra] += 1


def cluster_points_haversine(lats: List[float], lons: List[float], radius_m: float) -> List[int]:
    """
    Cluster points using DBSCAN(haversine) if available, else union-find O(N^2).
    Returns an array of labels 0..K-1.
    """
    n = len(lats)
    if n == 0:
        return []
    # Try scikit-learn
    try:
        from sklearn.cluster import DBSCAN
        import numpy as np
        X = np.radians(np.column_stack([lats, lons]))
        eps = radius_m / EARTH_RADIUS_M  # radians
        labels = DBSCAN(eps=eps, min_samples=1, metric="haversine").fit_predict(X)
        # Reindex labels to 0..K-1
        uniq = {lab: i for i, lab in enumerate(sorted(set(labels)))}
        return [uniq[lab] for lab in labels]
    except Exception:
        pass

    # Fallback: union-find with pairwise comparisons
    uf = UnionFind(n)
    for i in range(n):
        for j in range(i+1, n):
            d = haversine_m(lats[i], lons[i], lats[j], lons[j])
            if d <= radius_m:
                uf.union(i, j)
    # Collapse to labels 0..K-1
    roots = [uf.find(i) for i in range(n)]
    uniq = {}
    next_id = 0
    labels = []
    for r in roots:
        if r not in uniq:
            uniq[r] = next_id
            next_id += 1
        labels.append(uniq[r])
    return labels


def mode(values: Iterable[str]) -> str:
    vals = [v for v in values if v and str(v).strip()]
    if not vals:
        return ""
    c = Counter(vals).most_common(1)[0][0]
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input_csv", help="Tidy per-slice schedule CSV (e.g., output.csv)")
    ap.add_argument("clusters_csv", help="Path to write cluster summaries (one row per cluster)")
    ap.add_argument("members_csv", help="Path to write cluster members (one row per meter)")
    ap.add_argument("--radius-m", type=float, default=20.0, help="Spatial radius in meters to club meters (default: 20)")
    ap.add_argument("--signature-fields", nargs="+",
                    default=["days", "from_time", "to_time", "time_limit_min",
                             "meter_state", "schedule_type", "applied_rule", "cap_color"],
                    help="Fields used to define 'same schedule' signature")
    args = ap.parse_args()

    df = pd.read_csv(args.input_csv, dtype=str, keep_default_na=False)

    # Required columns
    required_cols = {"post_id", "longitude", "latitude"}
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        sys.exit(f"Missing required columns in input CSV: {missing}")

    # Ensure lon/lat numeric
    df["longitude"] = pd.to_numeric(df["longitude"], errors="coerce")
    df["latitude"]  = pd.to_numeric(df["latitude"], errors="coerce")
    df = df.dropna(subset=["longitude", "latitude"]).copy()

    # Group rows by post_id to build each meter's full schedule signature
    meters = []
    for pid, g in df.groupby("post_id", sort=False):
        schedule_hash, schedule_entries = build_schedule_signature(g, args.signature_fields)
        meters.append({
            "post_id": pid,
            "longitude": g["longitude"].astype(float).mean(),
            "latitude": g["latitude"].astype(float).mean(),
            "street_name": mode(g.get("street_name", [])) if "street_name" in g else "",
            "street_num": mode(g.get("street_num", [])) if "street_num" in g else "",
            "blockface_id": mode(g.get("blockface_id", [])) if "blockface_id" in g else "",
            "cap_color": mode(g.get("cap_color", [])) if "cap_color" in g else "",
            "schedule_hash": schedule_hash,
            "schedule_json": json.dumps(schedule_entries, ensure_ascii=False),
        })
    mdf = pd.DataFrame(meters)

    # For each schedule_hash, spatially cluster the meters
    cluster_records = []
    member_records = []

    global_cluster_id = 0
    for shash, g in mdf.groupby("schedule_hash", sort=False):
        lats = g["latitude"].astype(float).tolist()
        lons = g["longitude"].astype(float).tolist()
        labels = cluster_points_haversine(lats, lons, args.radius_m)

        # attach labels to group
        g = g.copy()
        g["local_cluster"] = labels

        for lc, sub in g.groupby("local_cluster"):
            global_cluster_id += 1
            cid = f"C{global_cluster_id:05d}"
            # centroid
            clat = float(sub["latitude"].mean())
            clon = float(sub["longitude"].mean())
            # max radius from centroid (diagnostics)
            max_r = 0.0
            for _, r in sub.iterrows():
                max_r = max(max_r, haversine_m(clat, clon, float(r["latitude"]), float(r["longitude"])))

            # summarize human fields
            street = mode(sub["street_name"]) if "street_name" in sub else ""
            cap = mode(sub["cap_color"]) if "cap_color" in sub else ""
            blockfaces = sorted({str(x) for x in sub.get("blockface_id", []) if str(x).strip()}) if "blockface_id" in sub else []
            post_ids = sorted(sub["post_id"].astype(str).tolist())

            cluster_records.append({
                "cluster_id": cid,
                "schedule_hash": shash,
                "count_meters": len(sub),
                "post_ids": "|".join(post_ids),
                "centroid_latitude": clat,
                "centroid_longitude": clon,
                "approx_max_radius_m": round(max_r, 2),
                "street_name_mode": street,
                "cap_color_mode": cap,
                "blockface_ids": "|".join(blockfaces),
                "schedule_json": sub["schedule_json"].iloc[0],  # same for all in group
            })

            for _, r in sub.iterrows():
                member_records.append({
                    "cluster_id": cid,
                    "post_id": r["post_id"],
                    "latitude": float(r["latitude"]),
                    "longitude": float(r["longitude"]),
                    "street_name": r.get("street_name", ""),
                    "street_num": r.get("street_num", ""),
                    "blockface_id": r.get("blockface_id", ""),
                    "cap_color": r.get("cap_color", ""),
                    "schedule_hash": shash,
                })

    # Write outputs
    cdf = pd.DataFrame(cluster_records)
    mdf2 = pd.DataFrame(member_records)

    cdf.to_csv(args.clusters_csv, index=False)
    mdf2.to_csv(args.members_csv, index=False)

    print(f"Wrote {len(cdf)} clusters to {args.clusters_csv} and {len(mdf2)} members to {args.members_csv}.")

if __name__ == "__main__":
    main()
