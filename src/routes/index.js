const express = require('express');
const router = express.Router();
const { bestPerCombo, bestRunForRecipe, bestRunForRecipeAtConcurrency } = require('../lib/queries');
const { REFERENCE_CELL } = require('../lib/constants');
const recipes = require('../lib/recipes');

// Hand-picked, not derived: these are the two recipes with a real story
// behind the number, chosen by a person reading the results table rather
// than "whichever recipe currently tops a sort." If the roster changes,
// change this list — it intentionally isn't "top N by throughput," which
// would just surface the highest-concurrency cell of whatever model is
// smallest. The blurb is written for this card specifically (the recipe's
// own multi-paragraph description is for the recipe detail page, where a
// <pre> block can preserve its line breaks — collapsed into one card-sized
// line here it would just run its sentences together).
const FEATURED_RECIPES = [
  {
    name: 'vllm-sycl-balanced',
    blurb: 'Serving several requests at once — a small team, or an agent loop with more than one call in flight. The higher-throughput of the two backends once concurrency climbs.',
  },
  {
    name: 'llamacpp-vulkan-balanced',
    blurb: 'The simplest working setup: no oneAPI/SYCL toolchain to install, and close behind on throughput. Start here if you just want it running.',
  },
];

router.get('/', (req, res) => {
  const bestRuns = bestPerCombo();

  const featuredRecipes = FEATURED_RECIPES.map(({ name, blurb }) => {
    const recipe = recipes.byName(name);
    if (!recipe) return null;
    return {
      recipe,
      blurb,
      bestRun: bestRunForRecipe(name),
      // The unqualified "best run" lands on whatever concurrency was
      // tested highest (8 or 16) — real, but not what a single person or a
      // couple of household users will see. Show that case too, not just
      // the max-throughput headline.
      soloRun: bestRunForRecipeAtConcurrency(name, 2),
    };
  }).filter(Boolean);

  // `stats` comes from res.locals (see src/app.js) — the footer needs it on
  // every page, so this route doesn't pass its own copy.
  res.render('index', {
    title: 'Home',
    bestRuns,
    featuredRecipes,
    // The table is pinned to this cell rather than ranking over every cell,
    // so the page has to say which cell it is.
    referenceCell: REFERENCE_CELL,
  });
});

module.exports = router;
