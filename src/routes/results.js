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
    concurrency: req.query.concurrency || '',
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
