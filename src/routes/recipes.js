const express = require('express');
const router = express.Router();
const recipes = require('../lib/recipes');
const {
  getVerified,
  bestRunForRecipeAtExactConcurrency,
  maxCleanContextForRecipe,
} = require('../lib/queries');

// Parallel headline stat is fixed at 8 concurrent requests — not the
// highest concurrency tested (16), which skews toward a workload nobody
// running a recipe at home actually has, and not 1, which the "solo" stat
// already covers. 8 is the site's own stand-in for "a small household or
// team," the same shape the "balanced" profile targets.
const PARALLEL_HEADLINE_CONCURRENCY = 8;

// The three headline numbers every recipe card/page leads with: solo
// throughput, throughput at PARALLEL_HEADLINE_CONCURRENCY, and the largest
// context this recipe has actually run clean at. Any of the three can come
// back null — a recipe that has never been benchmarked at concurrency 8, or
// at all, should show "not yet measured" rather than a fabricated number.
function headlineStats(name) {
  return {
    speedSolo: bestRunForRecipeAtExactConcurrency(name, 1),
    speedParallel: bestRunForRecipeAtExactConcurrency(name, PARALLEL_HEADLINE_CONCURRENCY),
    maxContext: maxCleanContextForRecipe(name),
  };
}

router.get('/', (req, res) => {
  const withStats = recipes.all().map((r) => ({ ...r, stats: headlineStats(r.name) }));
  res.render('recipes', {
    title: 'Recipes',
    recipes: withStats,
    parallelConcurrency: PARALLEL_HEADLINE_CONCURRENCY,
  });
});

router.get('/:name', (req, res, next) => {
  // byName is the whitelist: only a file that was on disk at boot resolves,
  // so the path segment can't reach anything else. Same shape as the
  // enum-checked segments in routes/configs.js.
  const recipe = recipes.byName(req.params.name);
  if (!recipe) return next();

  res.render('recipe-detail', {
    title: recipe.name,
    recipe,
    stats: headlineStats(recipe.name),
    parallelConcurrency: PARALLEL_HEADLINE_CONCURRENCY,
    // The runs this recipe actually produced — the evidence behind it.
    runs: getVerified({ recipe: recipe.name, sort: 'generation_tok_s', dir: 'desc' }),
  });
});

module.exports = router;
