const express = require('express');
const router = express.Router();
const { bestPerCombo, getStats } = require('../lib/queries');

router.get('/', (req, res) => {
  const bestRuns = bestPerCombo();
  const stats = getStats();

  res.render('index', {
    title: 'Home',
    bestRuns,
    stats,
  });
});

module.exports = router;
