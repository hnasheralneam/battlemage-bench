const express = require('express');
const router = express.Router();
const { backendComparison, knownBadRuns } = require('../lib/queries');
const { VERIFICATION_LEVELS } = require('../lib/constants');

// A pair is only as trustworthy as its weaker side, so that is what the row
// advertises. VERIFICATION_LEVELS runs strongest-first, so the weaker level
// is whichever sits later in it.
function weakerLevel(a, b) {
  return VERIFICATION_LEVELS.indexOf(a) >= VERIFICATION_LEVELS.indexOf(b) ? a : b;
}

// Median rather than mean: with few pairs, one outlier workload would
// otherwise set the headline figure for the whole backend comparison.
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

router.get('/', (req, res) => {
  const pairs = backendComparison().map((p) => ({
    ...p,
    // Percentage SYCL is ahead of Vulkan on generation throughput; negative
    // means Vulkan won. Guarded against a zero denominator.
    deltaPct: p.vulkan_gen ? ((p.sycl_gen - p.vulkan_gen) / p.vulkan_gen) * 100 : null,
    // A pair where either side crashed isn't a clean win — the table says so
    // rather than silently ranking an unstable run above a stable one.
    unstable: Boolean(p.vulkan_crashed || p.sycl_crashed),
    level: weakerLevel(p.vulkan_level, p.sycl_level),
  }));

  const summary = {
    total: pairs.length,
    syclWins: pairs.filter((p) => p.sycl_gen > p.vulkan_gen).length,
    vulkanWins: pairs.filter((p) => p.vulkan_gen > p.sycl_gen).length,
    medianDeltaPct: median(pairs.filter((p) => p.deltaPct !== null).map((p) => p.deltaPct)),
  };

  res.render('compare', {
    title: 'Compare',
    pairs,
    summary,
    knownBad: knownBadRuns(),
  });
});

module.exports = router;
