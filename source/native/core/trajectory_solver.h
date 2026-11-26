#pragma once

#include <array>
#include <cstddef>
#include <vector>

struct TrajectoryConstraint {
    std::size_t start;
    std::size_t count;
    std::array<double, 8> values;
    double target;
    double weight;
    double huber; // Zero disables robust reweighting.
};

struct TrajectorySolution {
    std::vector<double> coefficients;
    bool fitted;
};

TrajectorySolution solve_trajectory_band(const std::vector<TrajectoryConstraint>& rows,
                                         const std::vector<double>& seed);
