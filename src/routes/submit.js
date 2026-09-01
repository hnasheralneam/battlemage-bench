const express = require('express');
const router = express.Router();
const { validateSubmission } = require('../lib/validate');
const { insertSubmission, SUBMISSION_INPUT_COLUMNS } = require('../lib/queries');
const { CARDS, BACKENDS, RUNTIMES, TRISTATE, MODELS } = require('../lib/constants');
const recipes = require('../lib/recipes');
const { AGENT_PROMPT } = require('../lib/agentPrompt');

const EMPTY_FORM = Object.fromEntries(SUBMISSION_INPUT_COLUMNS.map((c) => [c, '']));

// Suggestions for the model and recipe fields. Neither constrains what can be
// submitted — a result on another model, or on a configuration of your own,
// is still a result.
const MODEL_NAMES = MODELS.map((m) => m.name);
const RECIPE_NAMES = recipes.all().map((r) => r.name);

router.get('/', (req, res) => {
  res.render('submit', {
    title: 'Submit a result',
    CARDS,
    BACKENDS,
    RUNTIMES,
    TRISTATE,
    MODEL_NAMES,
    RECIPE_NAMES,
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
      MODEL_NAMES,
      RECIPE_NAMES,
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
