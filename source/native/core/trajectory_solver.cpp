#include "trajectory_solver.h"

#include <algorithm>
#include <cmath>

namespace {
constexpr int stride = 8;
constexpr int bandwidth = stride - 1;

// In-place banded Cholesky factorization and forward/back substitution.
bool solve_system(std::vector<double>& band, std::vector<double>& rhs) {
    const auto size = static_cast<int>(rhs.size());
    for (int i = 0; i < size; ++i) {
        const int row_start = std::max(0, i - bandwidth);
        for (int j = row_start; j <= i; ++j) {
            double value = band[i * stride + i - j];
            for (int k = row_start; k < j; ++k) {
                value -= band[i * stride + i - k] * band[j * stride + j - k];
            }
            if (i == j && !(value > 0)) return false;
            band[i * stride + i - j] = i == j ? std::sqrt(value) : value / band[j * stride];
        }
        for (int j = row_start; j < i; ++j) rhs[i] -= band[i * stride + i - j] * rhs[j];
        rhs[i] /= band[i * stride];
    }
    for (int i = size - 1; i >= 0; --i) {
        for (int j = i + 1; j < std::min(size, i + stride); ++j) {
            rhs[i] -= band[j * stride + j - i] * rhs[j];
        }
        rhs[i] /= band[i * stride];
        if (!std::isfinite(rhs[i])) return false;
    }
    return true;
}
} // namespace

TrajectorySolution solve_trajectory_band(const std::vector<TrajectoryConstraint>& rows,
                                         const std::vector<double>& seed) {
    for (const auto& row : rows) {
        if (row.count > row.values.size() || row.start > seed.size() || row.count > seed.size() - row.start) {
            return {seed, false};
        }
    }
    auto coefficients = seed;
    std::vector<double> band(seed.size() * stride);
    std::vector<double> rhs(seed.size());
    for (int iteration = 0; iteration < 3; ++iteration) {
        std::fill(band.begin(), band.end(), 0);
        std::fill(rhs.begin(), rhs.end(), 0);
        for (const auto& row : rows) {
            double weight = row.weight;
            if (row.huber > 0) {
                double estimate = 0;
                for (std::size_t i = 0; i < row.count; ++i) {
                    estimate += row.values[i] * coefficients[row.start + i];
                }
                const double error = std::abs(estimate - row.target);
                if (error > row.huber) weight *= row.huber / error;
            }
            for (std::size_t i = 0; i < row.count; ++i) {
                const auto index = row.start + i;
                const double value = row.values[i] * weight;
                rhs[index] += value * row.target;
                for (std::size_t j = 0; j <= i; ++j) {
                    band[index * stride + i - j] += value * row.values[j];
                }
            }
        }
        if (!solve_system(band, rhs)) return {seed, false};
        coefficients.swap(rhs);
    }
    return {std::move(coefficients), true};
}
