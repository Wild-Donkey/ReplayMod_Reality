#include "trajectory_seed.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace {
constexpr double radius = 6371000;
constexpr double rad = 3.14159265358979323846 / 180;
constexpr double margin = 4;
constexpr std::size_t max_points = 500000;

double wrap(double angle) { return std::atan2(std::sin(angle), std::cos(angle)); }

struct Vector { double east, north; };
struct Velocity { double seconds, lon, lat; };

Vector displacement(const GpsFix& a, const GpsFix& b) {
    return {wrap((b.lon-a.lon)*rad)*radius*std::cos(a.lat*rad), (b.lat-a.lat)*rad*radius};
}

double distance(const GpsFix& a, const GpsFix& b) {
    const auto delta = displacement(a,b);
    return std::hypot(delta.east,delta.north);
}

double tangent(double before, double after, double before_seconds, double after_seconds) {
    if (before * after <= 0) return 0;
    const double left = 2*after_seconds+before_seconds, right = after_seconds+2*before_seconds;
    return (left+right)/(left/before+right/after);
}

double smooth(double delta, double a, double b, double t) {
    return ((a+b-2*delta)*t+3*delta-2*a-b)*t*t+a*t;
}
} // namespace

bool build_gps_seeds(const std::vector<GpsFix>& fixes, double start, double end, GpsSeeds& seeds) {
    auto corrected = fixes;
    for (std::size_t i = 1; i + 1 < fixes.size(); ++i) {
        const auto& a = fixes[i-1];
        const auto& b = fixes[i];
        const auto& c = fixes[i+1];
        const double dt = b.time-a.time, du = c.time-b.time;
        if (dt <= 0 || du <= 0 || dt > 10 || du > 10) continue;
        const double first = distance(a,b), second = distance(b,c), direct = distance(a,c);
        if (first/dt > 100 && second/du > 100 && direct/(dt+du) < 50 &&
            first+second > std::max(100.,direct*4)) {
            const double ratio = dt/(dt+du);
            corrected[i].lon = wrap(a.lon*rad+wrap((c.lon-a.lon)*rad)*ratio)/rad;
            corrected[i].lat = a.lat+(c.lat-a.lat)*ratio;
            if (b.time >= start && b.time <= end) ++seeds.corrected;
        }
    }

    std::vector<Velocity> velocities;
    velocities.reserve(fixes.size());
    for (std::size_t i = 1; i < corrected.size(); ++i) {
        const auto& a = corrected[i-1];
        const auto& b = corrected[i];
        const double dt = b.time-a.time;
        velocities.push_back({dt,wrap((b.lon-a.lon)*rad)/dt,(b.lat-a.lat)*rad/dt});
    }
    const auto slope = [&](std::size_t index) {
        if (index == 0) return velocities.front();
        if (index == velocities.size()) return velocities.back();
        const auto& before = velocities[index-1];
        const auto& after = velocities[index];
        return Velocity{0, tangent(before.lon,after.lon,before.seconds,after.seconds),
                           tangent(before.lat,after.lat,before.seconds,after.seconds)};
    };

    const double analysis_start = start-margin, analysis_end = end+margin;
    std::size_t baseline_count = 0;
    seeds.points.reserve(fixes.size());
    for (std::size_t i = 0; i < corrected.size(); ++i) {
        const auto& a = corrected[i];
        ++baseline_count;
        if (a.time >= analysis_start && a.time <= analysis_end) seeds.points.push_back(a);
        if (i + 1 == corrected.size() || std::abs(a.lat) >= 90) continue;
        const auto& b = corrected[i+1];
        const double dt = b.time-a.time;
        const double from = std::max(analysis_start,a.time), to = std::min(analysis_end,b.time);
        if (dt <= 0 || to <= from) continue;
        const double steps = std::ceil(dt*10);
        const double first = std::max(1.,std::ceil((from-a.time)/dt*steps));
        const double last = std::min(steps-1,std::floor((to-a.time)/dt*steps));
        if (!std::isfinite(steps) || baseline_count + std::max(0.,last-first+1)+6 > max_points ||
            last >= 9007199254740991.) return false;

        const auto delta = displacement(a,b);
        const auto left = slope(i), right = slope(i+1);
        const double lon_scale = radius*std::cos(a.lat*rad);
        const Vector left_tangent{left.lon*dt*lon_scale,left.lat*dt*radius};
        const Vector right_tangent{right.lon*dt*lon_scale,right.lat*dt*radius};
        if (a.time < end && b.time > start) {
            if (dt > 10) ++seeds.bridged;
            if (std::max(std::hypot(left_tangent.east-delta.east,left_tangent.north-delta.north),
                              std::hypot(right_tangent.east-delta.east,right_tangent.north-delta.north)) > .01) {
                ++seeds.smoothed;
            }
        }

        std::vector<double> times{from,to};
        for (double step = first; step <= last; ++step) times.push_back(a.time+dt*step/steps);
        for (double edge : {start,end}) if (edge > from && edge < to) times.push_back(edge);
        std::sort(times.begin(),times.end());
        times.erase(std::unique(times.begin(),times.end()),times.end());
        for (double time : times) {
            if (time <= a.time || time >= b.time || time < from || time > to) continue;
            const double ratio = (time-a.time)/dt;
            const double x = smooth(delta.east,left_tangent.east,right_tangent.east,ratio);
            const double y = smooth(delta.north,left_tangent.north,right_tangent.north,ratio);
            const bool altitude = a.has_altitude && b.has_altitude && std::isfinite(a.altitude) && std::isfinite(b.altitude);
            seeds.points.push_back({time,wrap(a.lon*rad+x/lon_scale)/rad,a.lat+y/radius/rad,
                                    altitude ? a.altitude+(b.altitude-a.altitude)*ratio : 0.,
                                    altitude ? 1. : 0.});
            ++baseline_count;
        }
    }
    return true;
}
