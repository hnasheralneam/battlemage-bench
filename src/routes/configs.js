const express = require('express');
const router = express.Router();
const { getVerifiedForCombo } = require('../lib/queries');
const { CARDS, BACKENDS, RUNTIMES } = require('../lib/constants');

router.get('/:card/:backend/:runtime', (req, res) => {
  const { card, backend, runtime } = req.params;

  // Whitelist check — anything not an exact match 404s. Also closes off
  // SQL-injection-via-path-segment concerns since only these values ever
  // reach a query.
  if (!CARDS.includes(card) || !BACKENDS.includes(backend) || !RUNTIMES.includes(runtime)) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const runs = getVerifiedForCombo(card, backend, runtime);

  res.render('config-detail', {
    title: `${card} / ${backend} / ${runtime}`,
    card,
    backend,
    runtime,
    runs,
  });
});

module.exports = router;
