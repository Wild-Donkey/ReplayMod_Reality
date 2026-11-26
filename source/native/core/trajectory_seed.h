#pragma once

#include <vector>

struct GpsFix {
    double time, lon, lat, altitude, has_altitude;
};

struct GpsSeeds {
    std::vector<GpsFix> points;
    int corrected = 0;
    int smoothed = 0;
    int bridged = 0;
};

bool build_gps_seeds(const std::vector<GpsFix>& fixes, double start, double end, GpsSeeds& seeds);
