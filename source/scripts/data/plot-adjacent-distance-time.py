#!/usr/bin/env python3
import csv
import math
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


def haversine_metres(lon1, lat1, lon2, lat2):
    radius = 6_371_008.8
    lon1 = np.radians(lon1)
    lat1 = np.radians(lat1)
    lon2 = np.radians(lon2)
    lat2 = np.radians(lat2)
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    return 2 * radius * np.arcsin(np.minimum(1, np.sqrt(a)))


def read_points(csv_path):
    points = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                time = float(row["dataTime"])
                longitude = float(row["longitude"])
                latitude = float(row["latitude"])
            except (KeyError, TypeError, ValueError):
                continue
            if math.isfinite(time) and math.isfinite(longitude) and math.isfinite(latitude):
                points.append((time, longitude, latitude))
    points.sort(key=lambda point: point[0])
    return np.asarray(points, dtype=float)


def time_label(seconds):
    if seconds < 60:
        return f"{seconds:g} 秒"
    if seconds < 3600:
        return f"{seconds / 60:g} 分钟"
    if seconds < 86400:
        return f"{seconds / 3600:g} 小时"
    return f"{seconds / 86400:g} 天"


def distance_label(metres):
    if metres < 1000:
        return f"{metres:g} 米"
    return f"{metres / 1000:g} 千米"


def ticks_within(values, lower, upper):
    return [value for value in values if lower <= value <= upper]


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: plot-adjacent-distance-time.py INPUT.csv OUTPUT.png")

    input_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    points = read_points(input_path)
    delta_time = np.diff(points[:, 0])
    distance = haversine_metres(points[:-1, 1], points[:-1, 2], points[1:, 1], points[1:, 2])
    valid = (delta_time > 0) & (distance > 0) & np.isfinite(distance)
    delta_time = delta_time[valid]
    distance = distance[valid]

    log_time = np.log10(delta_time)
    log_distance = np.log10(distance)
    time_median = float(np.median(delta_time))
    distance_median = float(np.median(distance))

    plt.rcParams.update({
        "font.sans-serif": ["PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", "DejaVu Sans"],
        "axes.unicode_minus": False,
        "font.size": 11,
        "axes.titlesize": 18,
        "axes.labelsize": 13,
    })
    fig, ax = plt.subplots(figsize=(15, 9), dpi=400, constrained_layout=True)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#fbfcfe")

    ax.scatter(
        log_time,
        log_distance,
        s=3.2,
        c="#1769aa",
        alpha=0.075,
        linewidths=0,
        rasterized=True,
    )

    xmin, xmax = float(log_time.min()), float(log_time.max())
    ymin, ymax = float(log_distance.min()), float(log_distance.max())
    x_tick_values = ticks_within([1, 2, 5, 10, 30, 60, 300, 1800, 3600, 21600, 86400, 604800, 2592000], 10**xmin, 10**xmax)
    y_tick_values = ticks_within([0.1, 1, 10, 100, 1000, 10000, 100000, 1000000], 10**ymin, 10**ymax)
    ax.set_xticks(np.log10(x_tick_values), [time_label(value) for value in x_tick_values])
    ax.set_yticks(np.log10(y_tick_values), [distance_label(value) for value in y_tick_values])
    ax.tick_params(axis="x", labelrotation=28, pad=7)
    for label in ax.get_xticklabels():
        label.set_horizontalalignment("right")

    ax.axvline(np.log10(time_median), color="#ee6c4d", linewidth=1.3, linestyle="--", alpha=0.9)
    ax.axhline(np.log10(distance_median), color="#ee6c4d", linewidth=1.3, linestyle="--", alpha=0.9)
    ax.text(
        np.log10(time_median), ymax - 0.03 * (ymax - ymin),
        f" 时间中位数 {time_label(time_median)}", color="#b6452d", ha="left", va="top",
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.82, "pad": 2},
    )
    ax.text(
        xmax - 0.01 * (xmax - xmin), np.log10(distance_median),
        f"距离中位数 {distance_label(round(distance_median))} ", color="#b6452d", ha="right", va="bottom",
        bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.82, "pad": 2},
    )

    ax.set_title("相邻轨迹点的空间距离与时间间隔", loc="left", pad=30, weight="bold")
    ax.text(
        0, 1.015,
        f"完整数据：{len(points):,} 个轨迹点 · {len(delta_time):,} 组有效相邻点；每个圆点代表一组相邻轨迹点",
        transform=ax.transAxes, ha="left", va="bottom", color="#5f6b7a", fontsize=10.5,
    )
    ax.set_xlabel("相邻点时间间隔（对数尺度）", labelpad=12)
    ax.set_ylabel("相邻点空间距离（对数尺度）", labelpad=10)
    ax.grid(True, color="#d8dee8", linewidth=0.65, alpha=0.7)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color("#b9c2cf")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, bbox_inches="tight", pad_inches=0.22, facecolor="white")
    plt.close(fig)
    print(f"saved {output_path}")
    print(f"points={len(points)} pairs={len(delta_time)} time_median={time_median:.3f}s distance_median={distance_median:.3f}m")


if __name__ == "__main__":
    main()
