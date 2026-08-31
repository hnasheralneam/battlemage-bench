const express = require('express');
const router = express.Router();
const { validateSubmission } = require('../lib/validate');
const { insertSubmission, SUBMISSION_INPUT_COLUMNS } = require('../lib/queries');
const { CARDS, BACKENDS, RUNTIMES, TRISTATE } = require('../lib/constants');
const { AGENT_PROMPT } = require('../lib/agentPrompt');

const EMPTY_FORM = Object.fromEntries(SUBMISSION_INPUT_COLUMNS.map((c) => [c, '']));

router.get('/', (req, res) => {
  res.render('submit', {
    title: 'Submit a result',
    CARDS,
    BACKENDS,
    RUNTIMES,
    TRISTATE,
    values: EMPTY_FORM,
    errors: {},
    agentPrompt: AGENT_PROMPT,
  });
});

router.post('/', (req, res) => {
  const { valid, errors, data } = validateSubmission(req.body);

  if (!valid) {
    return res.status(400).render('submit', {
      title: 'Submit a result',
      CARDS,
      BACKENDS,
      RUNTIMES,
      TRISTATE,
      values: { ...EMPTY_FORM, ...req.body },
      errors,
      agentPrompt: AGENT_PROMPT,
    });
  }

  insertSubmission(data);
  res.redirect(
    '/submit/thanks?flash=' +
      encodeURIComponent('Thanks — your result is in the queue for review.') +
      '&flashType=success'
  );
});

router.get('/thanks', (req, res) => {
  res.render('submit-thanks', { title: 'Submitted' });
});

module.exports = router;
