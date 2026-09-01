const express = require('express');
const router = express.Router();
const recipes = require('../lib/recipes');
const { getVerified } = require('../lib/queries');

router.get('/', (req, res) => {
  res.render('recipes', {
    title: 'Recipes',
    recipes: recipes.all(),
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
    // The runs this recipe actually produced — the evidence behind it.
    runs: getVerified({ recipe: recipe.name, sort: 'generation_tok_s', dir: 'desc' }),
  });
});

module.exports = router;
