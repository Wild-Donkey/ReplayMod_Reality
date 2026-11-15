#!/usr/bin/env python3
"""Offline alignment experiment; emits candidates, never edits a track or video.

Uses only the Python standard library. Input telemetry is ExifTool -ee -j -G3:1
with SampleTime, Quaternion1..4, and optionally AccelerometerX/Y/Z.
Offset convention: GPS epoch = nominal video epoch + video seconds + offset.
Screen observations are manually transcribed evidence, not automatic OCR.
"""

import argparse
import bisect
import csv
import datetime as dt
import json
import math
from pathlib import Path
import statistics


def epoch(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("An explicit timezone is required")
    return parsed.timestamp()


def wrap(value):
    return math.atan2(math.sin(value), math.cos(value))


def rotate(q, v):
    w, x, y, z = q
    return (
        (1 - 2 * (y*y + z*z))*v[0] + 2*(x*y - w*z)*v[1] + 2*(x*z + w*y)*v[2],
        2*(x*y + w*z)*v[0] + (1 - 2*(x*x + z*z))*v[1] + 2*(y*z - w*x)*v[2],
        2*(x*z - w*y)*v[0] + 2*(y*z + w*x)*v[1] + (1 - 2*(x*x + y*y))*v[2],
    )


def load_imu(path):
    grouped = {}
    for key, value in json.loads(Path(path).read_text())[0].items():
        parts = key.split(":")
        if len(parts) != 3 or not parts[0].startswith("Doc"):
            continue
        try:
            grouped.setdefault(parts[0], {})[parts[-1]] = float(value)
        except (ValueError, TypeError):
            continue
    samples = []
    for row in grouped.values():
        if not all(k in row for k in ["SampleTime", *[f"Quaternion{i}" for i in range(1, 5)]]):
            continue
        q = [row[f"Quaternion{i}"] for i in range(1, 5)]
        norm = math.sqrt(sum(x*x for x in q))
        if not math.isfinite(norm) or norm < 1e-8:
            continue
        row["q"] = [x / norm for x in q]
        samples.append(row)
    return sorted(samples, key=lambda r: r["SampleTime"])


def load_gps(path, base, radius):
    rows = {}
    with open(path, encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            try:
                point = tuple(float(row[k]) for k in ("dataTime", "longitude", "latitude"))
                if not all(math.isfinite(x) for x in point):
                    continue
                if not (-180 <= point[1] <= 180 and -90 <= point[2] <= 90):
                    continue
                if abs(point[0] - base) > radius:
                    continue
                accuracy = float(row.get("accuracy") or "nan")
                if math.isfinite(accuracy) and accuracy > 100:
                    continue
                speed = float(row.get("speed") or "nan")
                rows[point] = (point[0] - base, point[1], point[2], speed)
            except (ValueError, KeyError):
                continue
    return sorted(rows.values())


def peaks(rows, field, count=8, separation=12):
    selected = []
    for row in sorted(rows, key=lambda r: r[field]):
        if all(abs(row["offset_seconds"] - other["offset_seconds"]) > separation for other in selected):
            selected.append(row)
        if len(selected) >= count:
            break
    return selected


def run(args):
    base = epoch(args.nominal_start)
    imu = load_imu(args.telemetry)
    if len(imu) < 2:
        raise ValueError("At least two orientation samples are required")
    gps = load_gps(args.gps, base, args.radius + imu[-1]["SampleTime"] + 60)
    times = [r["SampleTime"] for r in imu]
    gps_times = [r[0] for r in gps]
    lo, hi = 5.0, min(67.0, times[-1])
    if hi - lo < 20:
        raise ValueError("This experiment requires at least 25 seconds of telemetry")
    # X/Y are alternative mounting hypotheses, not a calibrated vehicle frame.
    orientation = {}
    for axis, vector in [("x", (1, 0, 0)), ("y", (0, 1, 0))]:
        angles = [math.atan2((f := rotate(r["q"], vector))[1], f[0]) for r in imu]
        cosine, sine = [0.0], [0.0]
        for a in angles:
            cosine.append(cosine[-1] + math.cos(a))
            sine.append(sine[-1] + math.sin(a))
        orientation[axis] = (cosine, sine)

    def heading_candidate(offset, axis, sign):
        residuals = []
        cosine, sine = orientation[axis]
        for a, b in zip(gps, gps[1:]):
            start, end = a[0] - offset, b[0] - offset
            span = end - start
            if not (lo <= start < end <= hi and span <= 18):
                continue
            east = (b[1] - a[1]) * math.cos(math.radians(a[2]))
            north = b[2] - a[2]
            if math.hypot(east, north) * 111195 < 10:
                continue
            i, j = bisect.bisect_left(times, start), bisect.bisect_right(times, end)
            if j <= i:
                continue
            imu_heading = math.atan2(sine[j] - sine[i], cosine[j] - cosine[i])
            residuals.append((span, wrap(math.atan2(east, north) - sign * imu_heading)))
        covered = sum(w for w, _ in residuals)
        if len(residuals) < 7 or covered < .75 * (hi - lo):
            return None
        center = math.atan2(sum(w*math.sin(e) for w, e in residuals), sum(w*math.cos(e) for w, e in residuals))
        error = math.sqrt(sum(w*wrap(e-center)**2 for w, e in residuals) / covered)
        return dict(offset_seconds=offset, axis=axis, sign=sign,
                    heading_rmse_degrees=math.degrees(error),
                    fitted_heading_offset_degrees=math.degrees(center),
                    gps_intervals=len(residuals), covered_seconds=covered)

    def speed_at(time):
        j = bisect.bisect_right(gps_times, time)
        if j == 0 or j == len(gps):
            return None
        a, b = gps[j-1], gps[j]
        if b[0] - a[0] > 20 or not all(math.isfinite(r[3]) and r[3] >= 0 for r in (a, b)):
            return None
        return (a[3] + (b[3]-a[3]) * (time-a[0]) / (b[0]-a[0])) * 3.6

    observed = json.loads(Path(args.observations).read_text()) if args.observations else {}
    speed_observations = observed.get("phone_speed_kmh", [])
    heading_scan, speed_scan = [], []
    for i in range(round(-args.radius / args.step), round(args.radius / args.step) + 1):
        offset = round(i * args.step, 8)
        candidates = [r for axis in orientation for sign in (-1, 1)
                      if (r := heading_candidate(offset, axis, sign))]
        if candidates:
            heading_scan.append(min(candidates, key=lambda r: r["heading_rmse_degrees"]))
        speed_pairs = [(o["video_seconds"], o["kmh"], speed_at(o["video_seconds"] + offset)) for o in speed_observations]
        if speed_pairs and all(v is not None for _, _, v in speed_pairs):
            speed_scan.append(dict(offset_seconds=offset,
                                   speed_rmse_kmh=math.sqrt(statistics.mean((a-b)**2 for _, a, b in speed_pairs)),
                                   pairs=speed_pairs))

    clock = observed.get("phone_minute_boundary")
    clock_constraint = None
    if clock:
        minute = epoch(clock["new_minute_start"])
        # Before frame still shows the old minute; after frame shows the new one.
        lower = minute - base - clock["first_confirmed_new_video_seconds"]
        upper = minute - base - clock["last_confirmed_old_video_seconds"]
        clock_constraint = dict(offset_bounds_seconds=[lower, upper],
                                assumptions=["phone wall clock agrees with GPS epoch",
                                             "status bar refresh latency is not included in these observational bounds"],
                                heading_best_inside_bounds=peaks([r for r in heading_scan if lower <= r["offset_seconds"] <= upper], "heading_rmse_degrees", 1),
                                speed_best_inside_bounds=peaks([r for r in speed_scan if lower <= r["offset_seconds"] <= upper], "speed_rmse_kmh", 1))

    gravity = [rotate(r["q"], [r["Accelerometer"+a] for a in "XYZ"]) for r in imu if all("Accelerometer"+a in r for a in "XYZ")]
    return dict(offset_convention="GPS_epoch = nominal_video_epoch + video_seconds + offset_seconds",
                nominal_start=args.nominal_start, sample_count=len(imu),
                imu_range_seconds=[times[0], times[-1]],
                imu_interval_median_seconds=statistics.median(b-a for a, b in zip(times, times[1:])),
                gps_points_in_search=len(gps),
                gps_interval_median_seconds=statistics.median(b-a for a, b in zip(gps_times, gps_times[1:])),
                rotated_acceleration_median=[statistics.median(a[i] for a in gravity) for i in range(3)] if gravity else None,
                acceleration_note="Near-unit gravity supports, but does not certify, a g unit. No acceleration is integrated for position correction.",
                heading_candidates=peaks(heading_scan, "heading_rmse_degrees"),
                screen_speed_candidates=peaks(speed_scan, "speed_rmse_kmh"),
                phone_clock_constraint=clock_constraint,
                warnings=["Heading search fits mounting offset and tests both signs; these are hypotheses, not a mounting calibration.",
                          "A single short clip with camera yaw relative to vehicle can produce convincing false matches.",
                          "Phone speed readings are manually transcribed and correlated with GPS, not independent ground truth.",
                          "Clock offset and GPS measurement/filter latency must be modeled separately.",
                          "This research report is not a production alignment or a corrected GPS track."],
                heading_scan=heading_scan, screen_speed_scan=speed_scan)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--telemetry", required=True)
    parser.add_argument("--gps", required=True)
    parser.add_argument("--nominal-start", required=True)
    parser.add_argument("--observations")
    parser.add_argument("--radius", type=float, default=600)
    parser.add_argument("--step", type=float, default=.5)
    parser.add_argument("--out", required=True)
    options = parser.parse_args()
    if options.radius <= 0 or options.step <= 0:
        parser.error("radius and step must be positive")
    result = run(options)
    Path(options.out).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({
        "sample_count": result["sample_count"],
        "heading_candidates": result["heading_candidates"][:3],
        "screen_speed_candidates": [
            {k: v for k, v in r.items() if k != "pairs"}
            for r in result["screen_speed_candidates"][:3]
        ],
        "phone_clock_offset_bounds_seconds": (
            result["phone_clock_constraint"]["offset_bounds_seconds"]
            if result["phone_clock_constraint"] else None
        ),
        "report": options.out,
    }, indent=2, ensure_ascii=False))
