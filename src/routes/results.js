const express = require('express');
const router = express.Router();
const { getVerified } = require('../lib/queries');
const { CARDS, BACKENDS, RUNTIMES } = require('../lib/constants');

router.get('/', (req, res) => {
  const filters = {
    card: req.query.card || '',
    backend: req.query.backend || '',
    runtime: req.query.runtime || '',
    quant: req.query.quant || '',
    q: req.query.q || '',
    concurrency: req.query.concurrency || '',
    prefill: req.query.prefill || '',
    recipe: req.query.recipe || '',
    sort: req.query.sort || 'created_at',
    dir: req.query.dir || 'desc',
  };
  const rows = getVerified(filters);

  res.render('results', {
    title: 'Results',
    rows,
    filters,
    CARDS,
    BACKENDS,
    RUNTIMES,
  });
});

module.exports = router;
