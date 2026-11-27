#include "location_csv.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr std::size_t max_points = 2'000'000;
constexpr std::size_t absent = std::string_view::npos;
constexpr double missing = std::numeric_limits<double>::quiet_NaN();

struct Point { double time, lon, lat, altitude; };

struct PhotoKey {
    double time;
    std::int32_t lon, lat;
    bool operator==(const PhotoKey& other) const {
        return time == other.time && lon == other.lon && lat == other.lat;
    }
};

struct PhotoKeyHash {
    std::size_t operator()(const PhotoKey& key) const {
        auto hash = std::hash<double>{}(key.time);
        for (const auto value : {key.lon, key.lat}) {
            hash ^= std::hash<std::int32_t>{}(value) + 0x9e3779b9u + (hash << 6) + (hash >> 2);
        }
        return hash;
    }
};

std::int32_t photo_coordinate(double value) {
    return static_cast<std::int32_t>(std::lround(value * 1'000'000));
}

struct Dataset {
    std::vector<Point> footprint, photos;
    std::unordered_map<PhotoKey, std::size_t, PhotoKeyHash> photo_indices;
    std::size_t skipped = 0;
    double west = INFINITY, south = INFINITY, east = -INFINITY, north = -INFINITY;
    double start = INFINITY, end = -INFINITY;

    bool add(Point point, bool photo) {
        if (footprint.size() + photos.size() >= max_points) return false;
        if (photo) {
            const auto lon = photo_coordinate(point.lon), lat = photo_coordinate(point.lat);
            const auto [entry, inserted] = photo_indices.emplace(PhotoKey{point.time, lon, lat}, photos.size());
            if (inserted) photos.push_back(point);
            else photos[entry->second] = point;
        } else {
            footprint.push_back(point);
        }
        west = std::min(west, point.lon); east = std::max(east, point.lon);
        south = std::min(south, point.lat); north = std::max(north, point.lat);
        start = std::min(start, point.time); end = std::max(end, point.time);
        return true;
    }
};

std::string_view trim(std::string_view field) {
    const auto first = field.find_first_not_of(" \t");
    if (first == absent) return {};
    return field.substr(first, field.find_last_not_of(" \t") - first + 1);
}

void split(std::string_view row, std::vector<std::string_view>& fields) {
    fields.clear();
    for (;;) {
        const auto comma = row.find(',');
        fields.push_back(trim(row.substr(0, comma)));
        if (comma == absent) return;
        row.remove_prefix(comma + 1);
    }
}

// Fields point into the current line, where a comma or the string terminator
// ends the number. Compare the end pointer to the trimmed field boundary.
double number(std::string_view field) {
    if (field.empty()) return 0;
    char* end;
    const double value = std::strtod(field.data(), &end);
    return end == field.data() + field.size() ? value : missing;
}

void write_number(double value) {
    std::cout.write(reinterpret_cast<const char*>(&value), sizeof(value));
}
bool load_csv(const std::string& filename, bool force_photo, Dataset& dataset) {
    std::ifstream input(std::filesystem::u8path(filename), std::ios::binary);
    std::string line;
    if (!std::getline(input, line)) return false;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.compare(0, 3, "\xEF\xBB\xBF") == 0) line.erase(0, 3);
    std::vector<std::string_view> fields;
    split(line, fields);
    const auto column_count = fields.size();
    const auto column = [&](std::string_view name) {
        const auto found = std::find(fields.begin(), fields.end(), name);
        return found == fields.end() ? absent : static_cast<std::size_t>(found - fields.begin());
    };
    const auto time = column("dataTime"), longitude = column("longitude"), latitude = column("latitude");
    const auto accuracy = column("accuracy"), type = column("stepType");
    auto altitude = absent;
    for (const auto name : {"altitude", "elevation", "height", "alt"}) {
        altitude = column(name);
        if (altitude != absent) break;
    }
    if (time == absent || longitude == absent || latitude == absent) return false;

    while (std::getline(input, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        split(line, fields);
        if (fields.size() != column_count) return false;
        const double timestamp = number(fields[time]) * 1000;
        const double lon = number(fields[longitude]), lat = number(fields[latitude]);
        const double error = accuracy == absent ? 0 : number(fields[accuracy]);
        if (fields[time].empty() || !std::isfinite(timestamp) ||
            !(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) || (std::isfinite(error) && error > 100)) {
            ++dataset.skipped;
            continue;
        }
        const double height = altitude == absent || fields[altitude].empty() ? missing : number(fields[altitude]);
        const bool photo = force_photo || (type != absent && number(fields[type]) == 1);
        if (!dataset.add({timestamp, lon, lat, std::isfinite(height) ? height : missing}, photo)) return false;
    }
    return !input.bad();
}
} // namespace

int import_location_csv() {
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 1;
#endif
    std::string footprint, photos;
    if (!std::getline(std::cin, footprint) || footprint.empty()) return 1;
    std::getline(std::cin, photos);
    Dataset dataset;
    if (!load_csv(footprint, false, dataset) || (!photos.empty() && !load_csv(photos, true, dataset)) ||
        (dataset.footprint.empty() && dataset.photos.empty())) return 3;
    const auto by_time = [](const auto& a, const auto& b) { return a.time < b.time; };
    std::stable_sort(dataset.footprint.begin(), dataset.footprint.end(), by_time);
    std::stable_sort(dataset.photos.begin(), dataset.photos.end(), by_time);
    std::cout.write("RMRCSV02", 8);
    for (double value : {static_cast<double>(dataset.footprint.size()), static_cast<double>(dataset.photos.size()),
                         static_cast<double>(dataset.skipped), dataset.west, dataset.south, dataset.east,
                         dataset.north, dataset.start, dataset.end}) write_number(value);
    for (const auto* series : {&dataset.footprint, &dataset.photos}) {
        for (const auto& point : *series) {
            for (double value : {point.time, point.lon, point.lat, point.altitude}) write_number(value);
        }
    }
    std::cout.flush();
    return std::cout ? 0 : 1;
}
