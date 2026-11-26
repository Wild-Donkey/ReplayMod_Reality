#include "location_csv.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr int unsupported = 3;
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

std::optional<std::int32_t> photo_coordinate(double value) {
    const double scaled = std::abs(value) * 1'000'000;
    const double base = std::floor(scaled);
    // Near a rounding tie, delegate to the existing JS toFixed(6) key.
    if (std::abs(scaled - base - .5) <= std::numeric_limits<double>::epsilon() * std::max(1., scaled)) return {};
    const auto rounded = static_cast<std::int32_t>(std::round(scaled));
    // toFixed preserves the sign of a negative coordinate rounded to zero.
    return value < 0 ? (rounded ? -rounded : std::numeric_limits<std::int32_t>::min()) : rounded;
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
            if (!lon || !lat) return false;
            const auto [entry, inserted] = photo_indices.emplace(PhotoKey{point.time, *lon, *lat}, photos.size());
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

bool split_quoted(std::string_view row, std::vector<std::string_view>& fields, std::deque<std::string>& decoded) {
    for (;;) {
        const auto first = row.find_first_not_of(" \t");
        if (first != absent && row[first] == '"') {
            row.remove_prefix(first + 1);
            auto& value = decoded.emplace_back();
            for (;;) {
                const auto quote = row.find('"');
                if (quote == absent) return false; // Multiline fields use the compatibility parser.
                value.append(row.substr(0, quote));
                row.remove_prefix(quote + 1);
                if (row.empty() || row.front() != '"') break;
                value.push_back('"');
                row.remove_prefix(1);
            }
            fields.push_back(value);
            const auto delimiter = row.find_first_not_of(" \t");
            if (delimiter == absent) return true;
            if (row[delimiter] != ',') return false;
            row.remove_prefix(delimiter + 1);
        } else {
            const auto comma = row.find(',');
            const auto value = trim(row.substr(0, comma));
            if (value.find('"') != absent) return false;
            fields.push_back(value);
            if (comma == absent) return true;
            row.remove_prefix(comma + 1);
        }
    }
}

bool split(std::string_view row, std::vector<std::string_view>& fields, std::deque<std::string>& decoded) {
    bool quoted = false;
    for (const unsigned char ch : row) {
        if ((ch < 32 && ch != '\t') || ch >= 127) return false;
        if (ch == '"') quoted = true;
    }
    fields.clear();
    decoded.clear();
    if (quoted) return split_quoted(row, fields, decoded);
    for (;;) {
        const auto comma = row.find(',');
        fields.push_back(trim(row.substr(0, comma)));
        if (comma == absent) return true;
        row.remove_prefix(comma + 1);
    }
}

// The fast path accepts decimal numbers. Other spellings are delegated to
// the compatibility parser rather than reimplementing JavaScript Number().
bool decimal(std::string_view field, double& value) {
    field = trim(field);
    if (field.empty()) { value = 0; return true; }
    if (field.size() > 80 || field.find_first_not_of("0123456789.eE+-") != absent) return false;
    const std::string terminated(field);
    char* end;
    value = std::strtod(terminated.c_str(), &end);
    return end == terminated.c_str() + terminated.size() && end != terminated.c_str();
}

bool read_row(std::istream& input, std::string& line, bool crlf) {
    if (!std::getline(input, line)) return false;
    const bool has_cr = !line.empty() && line.back() == '\r';
    if ((!input.eof() && has_cr != crlf) || (input.eof() && has_cr)) return false;
    if (has_cr) line.pop_back();
    return true;
}

void write_number(double value) {
    std::cout.write(reinterpret_cast<const char*>(&value), sizeof(value));
}
bool load_csv(const std::string& filename, bool force_photo, Dataset& dataset) {
    std::ifstream input(std::filesystem::u8path(filename), std::ios::binary);
    std::string line;
    if (!std::getline(input, line)) return false;
    const bool crlf = !line.empty() && line.back() == '\r';
    if (crlf) line.pop_back();
    if (line.compare(0, 3, "\xEF\xBB\xBF") == 0) line.erase(0, 3);
    std::vector<std::string_view> fields;
    std::deque<std::string> decoded;
    if (!split(line, fields, decoded)) return false;
    const auto column_count = fields.size();
    const auto column = [&](std::string_view name) {
        const auto found = std::find(fields.begin(), fields.end(), name);
        return found == fields.end() ? absent : static_cast<std::size_t>(found - fields.begin());
    };
    auto sorted_headers = fields;
    std::sort(sorted_headers.begin(), sorted_headers.end());
    if (std::adjacent_find(sorted_headers.begin(), sorted_headers.end()) != sorted_headers.end()) return false;
    const auto time = column("dataTime"), longitude = column("longitude"), latitude = column("latitude");
    const auto accuracy = column("accuracy"), type = column("stepType");
    auto altitude = absent;
    for (const auto name : {"altitude", "elevation", "height", "alt"}) {
        altitude = column(name);
        if (altitude != absent) break;
    }
    if (time == absent || longitude == absent || latitude == absent) return false;

    while (input.peek() != std::char_traits<char>::eof()) {
        if (!read_row(input, line, crlf)) return false;
        if (line.empty()) continue;
        if (!split(line, fields, decoded) || fields.size() != column_count) return false;
        double seconds, lon, lat, step = 0, error = 0, height = missing;
        if (!decimal(fields[time], seconds) || !decimal(fields[longitude], lon) || !decimal(fields[latitude], lat) ||
            (type != absent && !decimal(fields[type], step)) || (accuracy != absent && !decimal(fields[accuracy], error)) ||
            (altitude != absent && !trim(fields[altitude]).empty() && !decimal(fields[altitude], height))) return false;
        const double timestamp = seconds * 1000;
        if (trim(fields[time]).empty() || !std::isfinite(timestamp) ||
            !(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) || (std::isfinite(error) && error > 100)) {
            ++dataset.skipped;
            continue;
        }
        if ((lon == 0 && std::signbit(lon)) || (lat == 0 && std::signbit(lat)) ||
            (timestamp == 0 && std::signbit(timestamp)) ||
            !dataset.add({timestamp, lon, lat, std::isfinite(height) ? height : missing}, force_photo || step == 1)) return false;
    }
    return !input.bad();
}
} // namespace

int import_location_csv() {
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);
    const unsigned short endian_check = 1;
    if (*reinterpret_cast<const unsigned char*>(&endian_check) != 1) return unsupported;
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 1;
#endif
    std::string footprint, photos;
    if (!std::getline(std::cin, footprint) || footprint.empty()) return 1;
    std::getline(std::cin, photos);
    Dataset dataset;
    if (!load_csv(footprint, false, dataset) || (!photos.empty() && !load_csv(photos, true, dataset)) ||
        (dataset.footprint.empty() && dataset.photos.empty())) return unsupported;
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
