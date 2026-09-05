const CARDS = ['B70', 'B65'];
const BACKENDS = ['Vulkan', 'SYCL'];
const RUNTIMES = ['llama.cpp', 'vLLM'];
const TRISTATE = ['on', 'off', 'unknown'];

// Who stands behind a published result, weakest claim last. Deliberately
// absent from SUBMISSION_INPUT_COLUMNS: a submitter must never be able to
// declare their own trust level, so this field exists only on the admin form.
const VERIFICATION_LEVELS = [
  'maintainer-measured',
  'reproduced',
  'community-reported',
];

// Short gloss per level, rendered as the legend under the results tables.
const VERIFICATION_LABELS = {
  'maintainer-measured': 'Run on this project\u2019s own hardware.',
  reproduced: 'Submitted, then re-run here with a matching result.',
  'community-reported': 'Submitted and reviewed, but not re-run here.',
};

// The models this site's own sweeps run. model_name stays free text in the
// schema — a submission on some other model is still welcome and still
// publishable — but these are what the benchmark runner is pointed at, what
// the results filter offers, and what /methodology documents.
//
// The set is chosen to vary the two things that actually move throughput on a
// 32 GB card, one at a time:
//   - dense vs MoE: Qwen3.8-27B against Qwen3.6-35B-A3B, same vendor and
//     roughly the same footprint, so the architecture is the only difference.
//   - vendor/architecture family: Muse Glimmer against Qwen3.8-27B, both
//     dense and about the same size, so a Qwen-specific result doesn't get
//     mistaken for a general one.
// All three fit on one card at 4-bit, which is the point of the card.
const MODELS = [
  {
    name: 'Qwen3.8-27B',
    vendor: 'Alibaba',
    architecture: '27B dense',
    note: 'The reference model. Dense, so throughput scales with the full parameter count.',
    llamacppQuant: 'Q4_K_M',
    vllmQuant: 'AWQ-4bit',
  },
  {
    name: 'Qwen3.6-35B-A3B',
    vendor: 'Alibaba',
    architecture: '35B MoE / ~3B active',
    note: 'Same vendor as the reference, different architecture — only ~3B parameters are active per token, which is the main way to get large-model quality out of 32 GB.',
    llamacppQuant: 'Q4_K_M',
    vllmQuant: 'AWQ-4bit',
  },
  {
    name: 'Muse-Glimmer-30B',
    vendor: 'Meta',
    architecture: '30B dense',
    note: 'Same shape as the reference, different vendor and tokenizer — the control for whether a result is about the card or about Qwen.',
    llamacppQuant: 'Q4_K_M',
    vllmQuant: 'AWQ-4bit',
  },
];

// Query-param name -> DB column name, for /results filtering. Only columns
// listed here are ever reachable from a request, and values are always bound
// as SQL parameters (never concatenated) wherever this is used.
const FILTERABLE = {
  card: 'card',
  backend: 'backend',
  runtime: 'runtime',
  quant: 'quantization',
  concurrency: 'concurrency',
  prefill: 'prompt_tokens',
  recipe: 'recipe',
  q: 'model_name',
};

// Filters matched with LIKE rather than equality. `quant` is a prefix match
// because the results form invites a partial string ("e.g. Q4_K_M") and an
// exact match silently returns nothing for "Q4". `q` is the free-text model
// search. Everything else in FILTERABLE stays an exact match; see
// buildFilterClause in queries.js, which escapes the LIKE wildcards.
const LIKE_FILTERS = {
  quant: 'prefix',
  q: 'substring',
};

// The cell the homepage's "best result per configuration" table is pinned to.
// Without a fixed reference, a best-of ranking over every cell just surfaces
// whichever run used the smallest model at the highest concurrency, and the
// six configurations stop being comparable with each other. Single-stream
// with a short prompt is the case most readers are sizing up.
const REFERENCE_CELL = { concurrency: 1, prompt_tokens: 256 };

// Whitelisted sortable columns for /results ?sort=.
const SORTABLE = [
  'generation_tok_s',
  'prompt_eval_tok_s',
  'tok_s_per_watt',
  'vram_used_mb',
  'context_length',
  'prompt_tokens',
  'created_at',
  'verified_at',
];

// Columns a submitter (via the public form / agent JSON paste / the bench
// runner scripts) is allowed to set. Deliberately excludes
// id/status/timestamps/tok_s_per_watt/admin_notes. Lives here rather than in
// queries.js because this module has no side effects (queries.js requires
// ../db, which opens the SQLite file on load) — code that just needs the
// schema's field list, like the offline benchmark runner, can import this
// without also opening a DB connection.
const SUBMISSION_INPUT_COLUMNS = [
  'submitter_name',
  'submitter_contact',
  'card',
  'backend',
  'runtime',
  'model_name',
  'quantization',
  'concurrency',
  'context_length',
  'prompt_tokens',
  'flash_attention',
  'mtp',
  'tensor_split',
  'full_command',
  'os_name',
  'kernel_version',
  'gpu_driver_version',
  'sdk_version',
  'runtime_version',
  'power_limit_watts',
  'measured_power_draw_watts',
  'vram_used_mb',
  'prompt_eval_tok_s',
  'generation_tok_s',
  'crashed',
  'stability_notes',
  'raw_log',
  'notes',
  // Which named launch recipe produced this row, and the KV cache precision
  // and mode it used. Both are what make a published number reproducible
  // from the recipes pages rather than only from full_command.
  'recipe',
  'kv_cache_type',
];

// Columns an admin may edit on a pending/rejected row before deciding.
const ADMIN_EDITABLE_COLUMNS = [
  ...SUBMISSION_INPUT_COLUMNS,
  'admin_notes',
  'verification_level',
];

module.exports = {
  CARDS,
  MODELS,
  REFERENCE_CELL,
  BACKENDS,
  RUNTIMES,
  TRISTATE,
  VERIFICATION_LEVELS,
  VERIFICATION_LABELS,
  FILTERABLE,
  LIKE_FILTERS,
  SORTABLE,
  SUBMISSION_INPUT_COLUMNS,
  ADMIN_EDITABLE_COLUMNS,
};
