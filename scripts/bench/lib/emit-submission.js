#!/usr/bin/env node
// Takes one benchmark cell's raw repeat results + system/run metadata and
// appends one line matching the site's submission schema to a JSONL file.
// Median-of-repeats and the schema field list live here (not in bash) so
// they can't silently drift or get miscomputed by shell arithmetic.
//
// The schema field list comes from src/lib/constants.js — the same
// zero-side-effect module the web app itself uses — so this can never
// emit a field set that doesn't match the DB (and importing it here never
// opens a DB connection, which matters since this may run on a different
// machine than the one hosting the site).
//
// Usage: see --help.

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { SUBMISSION_INPUT_COLUMNS, CARDS, BACKENDS, RUNTIMES } = require(
  path.join(__dirname, '..', '..', '..', 'src', 'lib', 'constants')
);

const HELP = `Usage: node emit-submission.js [options]

Required:
  --results-file <path>       JSONL file to append the submission row to
  --card <B70|B65>
  --backend <Vulkan|SYCL>
  --runtime <llama.cpp|vLLM>
  --model-name <name>
  --quantization <quant>
  --concurrency <n>
  --context-length <n>
  --full-command <string>     verbatim command that was actually run
  --repeats-json <json>       array of {generation_tok_s, prompt_eval_tok_s, ...}
                              from each repeat, in order; first entry is
                              treated as a warmup run and discarded when
                              more than one repeat is given

Optional:
  --system-info-file <path>   cache/system-info.json from
                              collect-system-info.sh (fills os/kernel/driver)
  --sdk-version <string>      overrides the backend-derived value from
                              --system-info-file
  --runtime-version <string>
  --flash-attention <on|off|unknown>   (default: unknown)
  --mtp <on|off|unknown>                (default: unknown)
  --tensor-split <string>
  --power-limit-watts <n>
  --measured-power-draw-watts <n>
  --vram-used-mb <n>
  --crashed <0|1>              (default: 0)
  --stability-notes <string>
  --notes <string>
  --submitter-name <string>    (default: from $USER)
`;

function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseArgv() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', default: false },
      'results-file': { type: 'string' },
      card: { type: 'string' },
      backend: { type: 'string' },
      runtime: { type: 'string' },
      'model-name': { type: 'string' },
      quantization: { type: 'string' },
      concurrency: { type: 'string' },
      'context-length': { type: 'string' },
      'full-command': { type: 'string' },
      'repeats-json': { type: 'string' },
      'system-info-file': { type: 'string' },
      'sdk-version': { type: 'string' },
      'runtime-version': { type: 'string' },
      'flash-attention': { type: 'string', default: 'unknown' },
      mtp: { type: 'string', default: 'unknown' },
      'tensor-split': { type: 'string' },
      'power-limit-watts': { type: 'string' },
      'measured-power-draw-watts': { type: 'string' },
      'vram-used-mb': { type: 'string' },
      crashed: { type: 'string', default: '0' },
      'stability-notes': { type: 'string' },
      notes: { type: 'string' },
      'submitter-name': { type: 'string' },
    },
  });
  return values;
}

function fail(message) {
  console.error(`emit-submission.js: ${message}`);
  console.error(HELP);
  process.exit(1);
}

function main() {
  const v = parseArgv();
  if (v.help) {
    console.log(HELP);
    return;
  }

  const required = [
    'results-file',
    'card',
    'backend',
    'runtime',
    'model-name',
    'quantization',
    'concurrency',
    'context-length',
    'full-command',
    'repeats-json',
  ];
  for (const key of required) {
    if (!v[key]) fail(`--${key} is required`);
  }
  if (!CARDS.includes(v.card)) fail(`--card must be one of: ${CARDS.join(', ')}`);
  if (!BACKENDS.includes(v.backend)) fail(`--backend must be one of: ${BACKENDS.join(', ')}`);
  if (!RUNTIMES.includes(v.runtime)) fail(`--runtime must be one of: ${RUNTIMES.join(', ')}`);

  let repeats;
  try {
    repeats = JSON.parse(v['repeats-json']);
  } catch (err) {
    fail(`--repeats-json is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(repeats) || repeats.length === 0) {
    fail('--repeats-json must be a non-empty JSON array');
  }

  const scored = repeats.length > 1 ? repeats.slice(1) : repeats; // discard warmup
  const generationTokS = median(scored.map((r) => r.generation_tok_s));
  const promptEvalTokS = median(scored.map((r) => r.prompt_eval_tok_s));

  if (generationTokS === null) {
    fail('no usable generation_tok_s value across the given repeats');
  }

  let systemInfo = {};
  if (v['system-info-file'] && fs.existsSync(v['system-info-file'])) {
    systemInfo = JSON.parse(fs.readFileSync(v['system-info-file'], 'utf8'));
  }
  const sdkVersion =
    v['sdk-version'] ||
    (v.backend === 'SYCL' ? systemInfo.sdk_version_sycl : systemInfo.sdk_version_vulkan) ||
    null;

  const row = {
    submitter_name: v['submitter-name'] || process.env.USER || 'Anonymous',
    submitter_contact: null,
    card: v.card,
    backend: v.backend,
    runtime: v.runtime,
    model_name: v['model-name'],
    quantization: v.quantization,
    concurrency: Number(v.concurrency),
    context_length: Number(v['context-length']),
    flash_attention: v['flash-attention'],
    mtp: v.mtp,
    tensor_split: v['tensor-split'] || null,
    full_command: v['full-command'],
    os_name: systemInfo.os_name || null,
    kernel_version: systemInfo.kernel_version || null,
    gpu_driver_version: systemInfo.gpu_driver_version || null,
    sdk_version: sdkVersion,
    runtime_version: v['runtime-version'] || null,
    power_limit_watts: v['power-limit-watts'] ? Number(v['power-limit-watts']) : null,
    measured_power_draw_watts: v['measured-power-draw-watts']
      ? Number(v['measured-power-draw-watts'])
      : null,
    vram_used_mb: v['vram-used-mb'] ? Number(v['vram-used-mb']) : null,
    prompt_eval_tok_s: promptEvalTokS,
    generation_tok_s: generationTokS,
    crashed: v.crashed === '1' ? 1 : 0,
    stability_notes: v['stability-notes'] || null,
    raw_log: JSON.stringify(
      {
        note:
          repeats.length > 1
            ? 'First repeat discarded as warmup; generation_tok_s/prompt_eval_tok_s are the median of the rest.'
            : 'Only one repeat was run.',
        repeats,
      },
      null,
      2
    ),
    notes: v.notes || null,
  };

  // Sanity check: the row we're about to write must have exactly the keys
  // the site's schema expects — catches a typo here before it becomes a bad
  // submission on disk.
  const rowKeys = Object.keys(row).sort();
  const expectedKeys = [...SUBMISSION_INPUT_COLUMNS].sort();
  if (JSON.stringify(rowKeys) !== JSON.stringify(expectedKeys)) {
    fail(
      `field mismatch against SUBMISSION_INPUT_COLUMNS.\n  built: ${rowKeys.join(',')}\n  expected: ${expectedKeys.join(',')}`
    );
  }

  fs.mkdirSync(path.dirname(v['results-file']), { recursive: true });
  fs.appendFileSync(v['results-file'], JSON.stringify(row) + '\n');
  console.log(
    `Wrote ${v.card}/${v.backend}/${v.runtime} @ concurrency=${v.concurrency}: ` +
      `${generationTokS.toFixed(1)} tok/s -> ${v['results-file']}`
  );
}

main();
