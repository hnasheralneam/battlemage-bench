const { CARDS, BACKENDS, RUNTIMES, TRISTATE } = require('./constants');

const REQUIRED_STRING_FIELDS = [
  'card',
  'backend',
  'runtime',
  'model_name',
  'quantization',
  'full_command',
];

const OPTIONAL_STRING_FIELDS = [
  'submitter_name',
  'submitter_contact',
  'tensor_split',
  'os_name',
  'kernel_version',
  'gpu_driver_version',
  'sdk_version',
  'runtime_version',
  'stability_notes',
  'raw_log',
  'notes',
  'recipe',
  'kv_cache_type',
];

// generation_tok_s is not in here: it is required only when the run did not
// crash. See the crashed handling in validateSubmission below.
const REQUIRED_NUMBER_FIELDS = ['concurrency', 'context_length'];

const OPTIONAL_NUMBER_FIELDS = [
  // prompt_tokens (prefill length) is deliberately optional, not required
  // like context_length — rows predating the prefill axis, and hand
  // submissions that didn't control prompt length, have no value for it.
  'prompt_tokens',
  'power_limit_watts',
  'measured_power_draw_watts',
  'vram_used_mb',
  'prompt_eval_tok_s',
  'generation_tok_s',
];

function trimOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined; // undefined signals "not a number"
}

// Validates a raw input object (from either the HTML form's req.body or a
// parsed JSON blob pasted from an agent). Returns { valid, errors, data }.
// `data` contains only the sanitized, submission-ready fields — never pass
// the raw input straight to insertSubmission.
function validateSubmission(input) {
  const errors = {};
  const data = {};

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = trimOrNull(input[field]);
    if (!value) errors[field] = 'Required.';
    data[field] = value;
  }

  if (data.card && !CARDS.includes(data.card)) {
    errors.card = `Must be one of: ${CARDS.join(', ')}.`;
  }
  if (data.backend && !BACKENDS.includes(data.backend)) {
    errors.backend = `Must be one of: ${BACKENDS.join(', ')}.`;
  }
  if (data.runtime && !RUNTIMES.includes(data.runtime)) {
    errors.runtime = `Must be one of: ${RUNTIMES.join(', ')}.`;
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    data[field] = trimOrNull(input[field]);
  }

  for (const field of ['flash_attention', 'mtp']) {
    const value = trimOrNull(input[field]) || 'unknown';
    if (!TRISTATE.includes(value)) {
      errors[field] = `Must be one of: ${TRISTATE.join(', ')}.`;
    }
    data[field] = value;
  }

  for (const field of REQUIRED_NUMBER_FIELDS) {
    const n = toNumberOrNull(input[field]);
    if (n === null || n === undefined) {
      errors[field] = 'Required and must be a number.';
    }
    data[field] = n === undefined ? null : n;
  }

  for (const field of OPTIONAL_NUMBER_FIELDS) {
    const n = toNumberOrNull(input[field]);
    if (n === undefined) {
      errors[field] = 'Must be a number.';
      data[field] = null;
    } else {
      data[field] = n;
    }
  }

  data.crashed =
    input.crashed === true || input.crashed === 'true' || input.crashed === 'on' || input.crashed === 1
      ? 1
      : 0;

  // A run that completed must report a real throughput figure. A run that
  // crashed measured nothing and records null — not 0, which would publish as
  // a legitimate-looking 0.0 tok/s result and pull down charts and the
  // homepage best-of ranking. The DB enforces the same invariant with a CHECK.
  if (data.crashed) {
    data.generation_tok_s = null;
  } else if (data.generation_tok_s === null) {
    errors.generation_tok_s = 'Required and must be a number, unless the run crashed.';
  } else if (data.generation_tok_s <= 0) {
    errors.generation_tok_s =
      'Must be greater than zero. If the run produced no tokens, mark it as crashed instead.';
  }

  return { valid: Object.keys(errors).length === 0, errors, data };
}

module.exports = { validateSubmission };
