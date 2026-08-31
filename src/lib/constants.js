const CARDS = ['B70', 'B65'];
const BACKENDS = ['Vulkan', 'SYCL'];
const RUNTIMES = ['llama.cpp', 'vLLM'];
const TRISTATE = ['on', 'off', 'unknown'];

// Query-param name -> DB column name, for /results filtering. Only columns
// listed here are ever reachable from a request, and values are always bound
// as SQL parameters (never concatenated) wherever this is used.
const FILTERABLE = {
  card: 'card',
  backend: 'backend',
  runtime: 'runtime',
  quant: 'quantization',
  concurrency: 'concurrency',
};

// Whitelisted sortable columns for /results ?sort=.
const SORTABLE = [
  'generation_tok_s',
  'prompt_eval_tok_s',
  'tok_s_per_watt',
  'vram_used_mb',
  'context_length',
  'created_at',
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
];

// Columns an admin may edit on a pending/rejected row before deciding.
const ADMIN_EDITABLE_COLUMNS = [...SUBMISSION_INPUT_COLUMNS, 'admin_notes'];

module.exports = {
  CARDS,
  BACKENDS,
  RUNTIMES,
  TRISTATE,
  FILTERABLE,
  SORTABLE,
  SUBMISSION_INPUT_COLUMNS,
  ADMIN_EDITABLE_COLUMNS,
};
