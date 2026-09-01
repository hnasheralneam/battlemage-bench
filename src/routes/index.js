const express = require('express');
const router = express.Router();
const { bestPerCombo } = require('../lib/queries');
const { REFERENCE_CELL } = require('../lib/constants');

router.get('/', (req, res) => {
  const bestRuns = bestPerCombo();

  // `stats` comes from res.locals (see src/app.js) — the footer needs it on
  // every page, so this route doesn't pass its own copy.
  res.render('index', {
    title: 'Home',
    bestRuns,
    // The table is pinned to this cell rather than ranking over every cell,
    // so the page has to say which cell it is.
    referenceCell: REFERENCE_CELL,
  });
});

module.exports = router;
