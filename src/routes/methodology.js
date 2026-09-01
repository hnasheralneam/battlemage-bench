const express = require('express');
const router = express.Router();
const { MODELS } = require('../lib/constants');

router.get('/', (req, res) => {
  // The models table is rendered from the same list the benchmark runner and
  // the submit form use, so the page can't claim a model set the tooling
  // isn't actually pointed at.
  res.render('methodology', { title: 'Methodology', MODELS });
});

module.exports = router;
