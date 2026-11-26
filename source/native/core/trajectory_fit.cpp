#include "trajectory_fit.h"
#include "trajectory_solver.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <optional>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr double radians = 3.14159265358979323846 / 180;
constexpr double metres = 6371000 * radians;
constexpr int context_seconds = 4;
using Position = std::array<double, 2>;
struct Fix { double time; Position position; double altitude; double has_altitude; };
struct Attitude { double time; double yaw; };
struct Calibration { double sign; double offset; double weight; };
struct Basis { std::size_t index; std::array<double, 4> weights; std::array<double, 4> derivative; };

double wrap(double angle) { return std::atan2(std::sin(angle), std::cos(angle)); }

template<class T>
auto upper(const std::vector<T>& points, double time) {
    return std::upper_bound(points.begin(), points.end(), time,
                            [](double t, const T& point) { return t < point.time; });
}

Fix seed_at(const std::vector<Fix>& seeds, double time) {
    const auto right = upper(seeds, time);
    const auto& a = *(right == seeds.begin() ? right : right - 1);
    const auto& b = *(right == seeds.end() ? right - 1 : right);
    const auto ratio = b.time > a.time ? std::clamp((time - a.time) / (b.time - a.time), 0., 1.) : 0.;
    return {time, {a.position[0] + ratio * (b.position[0] - a.position[0]),
                   a.position[1] + ratio * (b.position[1] - a.position[1])},
            a.altitude + ratio * (b.altitude - a.altitude), a.has_altitude && b.has_altitude ? 1. : 0.};
}

Basis basis(double time, int first_knot) {
    const auto cell = std::floor(time);
    const auto u = time - cell, u2 = u * u, u3 = u2 * u, v = 1 - u;
    return {static_cast<std::size_t>(2 * (cell - first_knot - 1)),
            {v*v*v/6, (4-6*u2+3*u3)/6, (1+3*u+3*u2-3*u3)/6, u3/6},
            {-.5*v*v, -2*u+1.5*u2, .5+u-1.5*u2, .5*u2}};
}

std::array<double, 8> axis(const std::array<double, 4>& values, double east, double north) {
    std::array<double, 8> result;
    for (std::size_t i = 0; i < values.size(); ++i) {
        result[2*i] = values[i] * east;
        result[2*i+1] = values[i] * north;
    }
    return result;
}

double evaluate(const std::vector<double>& coefficients, std::size_t start, const std::array<double, 8>& values) {
    double result = 0;
    for (std::size_t i = 0; i < values.size(); ++i) result += values[i] * coefficients[start+i];
    return result;
}

std::optional<double> yaw_at(const std::vector<Attitude>& attitude, double time) {
    const auto b = upper(attitude, time);
    if (b == attitude.begin()) return {};
    const auto a = b - 1;
    if (a->time == time) return a->yaw;
    if (b == attitude.end() || b->time - a->time > .25) return {};
    return a->yaw + wrap(b->yaw-a->yaw) * (time-a->time) / (b->time-a->time);
}

std::optional<Calibration> calibrate(const std::vector<Attitude>& attitude,
                                     std::vector<Fix>::const_iterator first, std::vector<Fix>::const_iterator last) {
    if (first == last) return {};
    std::array<double, 2> x{}, y{};
    double sum = 0;
    int count = 0;
    for (auto b = first + 1; b < last; ++b) {
        const auto a = b - 1;
        const double duration = b->time-a->time;
        const double east = b->position[0]-a->position[0], north = b->position[1]-a->position[1];
        if (duration < 1 || std::hypot(east,north)/duration < .75) continue;
        const auto lower = upper(attitude,a->time), upper_fix = upper(attitude,b->time);
        if (upper_fix-lower < 2 || lower->time-a->time > .25 || b->time-(upper_fix-1)->time > .25) continue;
        double dx = 0, dy = 0, covered = 0;
        for (auto sample = lower+1; sample < upper_fix; ++sample) {
            const auto previous = sample - 1;
            const double dt = sample->time-previous->time;
            if (dt > .25) continue;
            const auto yaw = previous->yaw + wrap(sample->yaw-previous->yaw)/2;
            dx += std::cos(yaw)*dt; dy += std::sin(yaw)*dt; covered += dt;
        }
        const double coherence = std::hypot(dx,dy)/duration;
        if (covered/duration < .85 || coherence < .35) continue;
        const auto course = std::atan2(east,north), camera = std::atan2(dy,dx);
        const double weight = coherence*std::min(duration,10.);
        for (int sign = 0; sign < 2; ++sign) {
            const double offset = course - (2*sign-1)*camera;
            x[sign] += std::cos(offset)*weight;
            y[sign] += std::sin(offset)*weight;
        }
        sum += weight;
        ++count;
    }
    if (!count) return {};
    const double negative = std::hypot(x[0],y[0])/sum, positive = std::hypot(x[1],y[1])/sum;
    const int best = positive > negative+.03 ? 1 : 0;
    const double agreement = best ? positive : negative;
    if (agreement < .65) return {};
    return Calibration{best ? 1. : -1., std::atan2(y[best],x[best]), std::min(1.,count/3.)*agreement};
}

struct Window {
    double start, end;
    int first_knot, constraints;
    std::vector<double> coefficients;

    Position at(double time) const {
        const auto b = basis(time, first_knot);
        return {evaluate(coefficients,b.index,axis(b.weights,1,0)), evaluate(coefficients,b.index,axis(b.weights,0,1))};
    }
};

Window fit_window(double start, double end, const std::vector<Fix>& anchors,
                  const std::vector<Fix>& seeds, const std::vector<Attitude>& attitude) {
    const int first_knot = static_cast<int>(std::floor(start))-1, last_knot = static_cast<int>(std::ceil(end))+2;
    std::vector<double> seed((last_knot-first_knot+1)*2);
    std::vector<TrajectoryConstraint> rows;
    for (int time = first_knot; time <= last_knot; ++time) {
        const auto position = seed_at(seeds,time).position;
        const auto index = static_cast<std::size_t>(2*(time-first_knot));
        for (std::size_t component = 0; component < 2; ++component) {
            seed[index+component] = position[component];
            rows.push_back({index+component,1,{1},position[component],.015,0});
            if (time >= first_knot+2) rows.push_back({index+component-4,5,{1,0,-2,0,1},0,.5,0});
        }
    }
    const auto first = std::lower_bound(anchors.begin(), anchors.end(), start,
                                        [](const Fix& point, double time) { return point.time < time; });
    const auto last = upper(anchors,end);
    for (auto fix = first; fix < last; ++fix) {
        const auto b = basis(fix->time,first_knot);
        rows.push_back({b.index,8,axis(b.weights,1,0),fix->position[0],15,4});
        rows.push_back({b.index,8,axis(b.weights,0,1),fix->position[1],15,4});
    }
    int constraints = 0;
    if (const auto calibration = calibrate(attitude,first,last)) {
        for (double time = std::ceil(start); time <= end; ++time) {
            const auto yaw = yaw_at(attitude,time), before = yaw_at(attitude,time-.5), after = yaw_at(attitude,time+.5);
            if (!yaw || !before || !after || std::abs(wrap(*after-*before)) > 1.2) continue;
            const auto b = basis(time,first_knot);
            const auto east = evaluate(seed,b.index,axis(b.derivative,1,0));
            const auto north = evaluate(seed,b.index,axis(b.derivative,0,1));
            const auto heading = *yaw*calibration->sign + calibration->offset;
            const auto sin = std::sin(heading), cos = std::cos(heading);
            const auto forward = east*sin+north*cos;
            if (std::hypot(east,north) < .75 || forward < -2) continue;
            rows.push_back({b.index,8,axis(b.derivative,cos,-sin),0,7*calibration->weight,3});
            rows.push_back({b.index,8,axis(b.derivative,sin,cos),std::max(0.,forward),.12,0});
            ++constraints;
        }
    }
    auto fit = solve_trajectory_band(rows,seed);
    return {start,end,first_knot,fit.fitted ? constraints : 0,std::move(fit.coefficients)};
}

template<std::size_t N>
bool read_numbers(std::array<double,N>& numbers) {
    return bool(std::cin.read(reinterpret_cast<char*>(numbers.data()), sizeof(double)*N));
}

template<std::size_t N>
void write_numbers(const std::array<double,N>& numbers) {
    std::cout.write(reinterpret_cast<const char*>(numbers.data()), sizeof(double)*N);
}

bool valid_count(double count, double limit) {
    return count >= 1 && count <= limit && count == std::floor(count);
}

bool read_fixes(std::vector<Fix>& fixes, std::size_t count) {
    fixes.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        std::array<double,5> row;
        if (!read_numbers(row) || !std::isfinite(row[0]) || !std::isfinite(row[1]) || !std::isfinite(row[2]) ||
            (i && row[0] < fixes.back().time)) return false;
        fixes.push_back({row[0],{row[1],row[2]},row[3],row[4]});
    }
    return true;
}
} // namespace

int fit_trajectory_stream() {
    const unsigned short endian = 1;
    if (sizeof(double) != 8 || !std::numeric_limits<double>::is_iec559 ||
        *reinterpret_cast<const unsigned char*>(&endian) != 1) return 3;
#ifdef _WIN32
    if (_setmode(_fileno(stdin),_O_BINARY) == -1 || _setmode(_fileno(stdout),_O_BINARY) == -1) return 1;
#endif
    std::ios::sync_with_stdio(false);
    std::array<double, 8> header;
    if (!read_numbers(header)) return 2;
    const auto [version,first_time,duration,rate,origin_lon,origin_lat,anchor_count,seed_count] = header;
    const double start = first_time, longitude = origin_lon, latitude = origin_lat;
    if (version != 1 || !std::isfinite(start) || !(duration > 0 && duration <= 49992) ||
        !valid_count(rate,60) || !std::isfinite(longitude) || !std::isfinite(latitude) ||
        !valid_count(anchor_count,100000) || !valid_count(seed_count,600000)) return 2;
    std::vector<Fix> anchors, seeds;
    if (!read_fixes(anchors,static_cast<std::size_t>(anchor_count)) ||
        !read_fixes(seeds,static_cast<std::size_t>(seed_count))) return 2;
    std::vector<Attitude> attitude;
    std::array<double,2> row;
    while (read_numbers(row)) {
        if (attitude.size() == 4'000'000 || !std::isfinite(row[0]) || !std::isfinite(row[1]) ||
            (!attitude.empty() && row[0] < attitude.back().time)) return 2;
        attitude.push_back({row[0],row[1]});
    }
    if (!std::cin.eof() || std::cin.gcount() != 0) return 2;

    std::vector<Window> windows;
    int constraints = 0;
    const auto tail = duration+context_seconds;
    for (double left = -context_seconds; left < tail; left += 240) {
        const double right = std::min(left+300,tail);
        windows.push_back(fit_window(left,right,anchors,seeds,attitude));
        constraints += windows.back().constraints;
        if (right == tail) break;
    }
    const auto steps = static_cast<int>(std::ceil(duration*rate));
    const auto context_steps = static_cast<int>(context_seconds*rate);
    write_numbers(std::array<double,5>{1,static_cast<double>(steps+1),static_cast<double>(2*context_steps),
                  static_cast<double>(windows.size()),static_cast<double>(constraints)});
    const double longitude_scale = metres*std::max(.001,std::cos(latitude*radians));
    std::size_t window = 0;
    const auto write_point = [&](double time) {
        while (window+1 < windows.size() && time >= windows[window].end) ++window;
        const auto& current = windows[window];
        auto [east,north] = current.at(time);
        if (window+1 < windows.size() && time >= windows[window+1].start) {
            const auto& next = windows[window+1];
            const double u = (time-next.start)/(current.end-next.start), weight = u*u*(3-2*u);
            const auto position = next.at(time);
            east += weight*(position[0]-east); north += weight*(position[1]-north);
        }
        const auto seed = seed_at(seeds,time);
        write_numbers(std::array<double,5>{start+time,wrap((longitude+east/longitude_scale)*radians)/radians,
                      std::clamp(latitude+north/metres,-90.,90.),seed.altitude,seed.has_altitude});
    };
    for (int step = 0; step < context_steps; ++step) write_point(-context_seconds+step/rate);
    for (int step = 0; step <= steps; ++step) write_point(duration*step/steps);
    for (int step = 1; step <= context_steps; ++step) write_point(duration+step/rate);
    std::cout.flush();
    return std::cout ? 0 : 1;
}
