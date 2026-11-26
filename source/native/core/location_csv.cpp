#include "location_csv.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
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

std::string_view trim(std::string_view field) {
    const auto first = field.find_first_not_of(" \t");
    if (first == absent) return {};
    return field.substr(first, field.find_last_not_of(" \t") - first + 1);
}

bool split(std::string_view row, std::vector<std::string_view>& fields) {
    for (const unsigned char ch : row) {
        if (ch == '"' || (ch < 32 && ch != '\t') || ch >= 127) return false;
    }
    fields.clear();
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
} // namespace

int import_location_csv() {
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);
    const unsigned short endian_check = 1;
    if (*reinterpret_cast<const unsigned char*>(&endian_check) != 1) return unsupported;
#ifdef _WIN32
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 1;
#endif
    std::string filename;
    if (!std::getline(std::cin, filename) || filename.empty()) return 1;
    std::ifstream input(std::filesystem::u8path(filename), std::ios::binary);
    std::string line;
    if (!std::getline(input, line)) return unsupported;
    const bool crlf = !line.empty() && line.back() == '\r';
    if (crlf) line.pop_back();
    if (line.compare(0, 3, "\xEF\xBB\xBF") == 0) line.erase(0, 3);
    std::vector<std::string_view> fields;
    if (!split(line, fields)) return unsupported;
    const auto column_count = fields.size();
    const auto column = [&](std::string_view name) {
        const auto found = std::find(fields.begin(), fields.end(), name);
        return found == fields.end() ? absent : static_cast<std::size_t>(found - fields.begin());
    };
    auto sorted_headers = fields;
    std::sort(sorted_headers.begin(), sorted_headers.end());
    if (std::adjacent_find(sorted_headers.begin(), sorted_headers.end()) != sorted_headers.end()) return unsupported;
    const auto time = column("dataTime"), longitude = column("longitude"), latitude = column("latitude");
    const auto accuracy = column("accuracy"), type = column("stepType");
    auto altitude = absent;
    for (const auto name : {"altitude", "elevation", "height", "alt"}) {
        altitude = column(name);
        if (altitude != absent) break;
    }
    if (time == absent || longitude == absent || latitude == absent) return unsupported;

    std::vector<Point> points;
    std::size_t skipped = 0;
    while (input.peek() != std::char_traits<char>::eof()) {
        if (!read_row(input, line, crlf)) return unsupported;
        if (line.empty()) continue;
        if (!split(line, fields) || fields.size() != column_count) return unsupported;
        double seconds, lon, lat, step = 0, error = 0, height = missing;
        if (!decimal(fields[time], seconds) || !decimal(fields[longitude], lon) || !decimal(fields[latitude], lat) ||
            (type != absent && !decimal(fields[type], step)) || (accuracy != absent && !decimal(fields[accuracy], error)) ||
            (altitude != absent && !fields[altitude].empty() && !decimal(fields[altitude], height))) return unsupported;
        const double timestamp = seconds * 1000;
        if (fields[time].empty() || !std::isfinite(timestamp) ||
            !(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90) || (std::isfinite(error) && error > 100)) {
            ++skipped;
            continue;
        }
        if (step == 1 || points.size() == max_points ||
            (lon == 0 && std::signbit(lon)) || (lat == 0 && std::signbit(lat)) ||
            (timestamp == 0 && std::signbit(timestamp))) return unsupported;
        points.push_back({timestamp, lon, lat, std::isfinite(height) ? height : missing});
    }
    if (input.bad() || points.empty()) return unsupported;
    std::stable_sort(points.begin(), points.end(), [](const auto& a, const auto& b) { return a.time < b.time; });
    const auto lon = std::minmax_element(points.begin(), points.end(), [](const auto& a, const auto& b) { return a.lon < b.lon; });
    const auto lat = std::minmax_element(points.begin(), points.end(), [](const auto& a, const auto& b) { return a.lat < b.lat; });
    std::cout.write("RMRCSV01", 8);
    for (double value : {static_cast<double>(points.size()), static_cast<double>(skipped),
                         lon.first->lon, lat.first->lat, lon.second->lon, lat.second->lat,
                         points.front().time, points.back().time}) write_number(value);
    for (const auto& point : points) {
        for (double value : {point.time, point.lon, point.lat, point.altitude}) write_number(value);
    }
    std::cout.flush();
    return std::cout ? 0 : 1;
}
