#!/usr/bin/env node
// Exits 0 if the given cell already has a row in the results file, 1 if not.
// The basis of --resume: a full three-model sweep is long enough that a crash
// partway through must not mean starting over.
//
// A cell is identified by everything that has to match for a rerun to be a
// rerun rather than a different measurement: card, backend, runtime, model,
// context length, concurrency and prefill length. Quantization is deliberately
// NOT part of the key — the same model re-run at a different quant is a
// different result, so including it would let a resume silently mix two
// quants into one sweep; instead the caller passes the model name it is
// running now, and a quant change means a new results file.
//
// prompt_tokens is compared with a tolerance because the recorded value is the
// prefill the run MEASURED, not the target it was asked for — calibration
// lands near the target, and vLLM's random dataset only approximates it.
//
// Usage:
//   node has-cell.js --file <results.jsonl> --card B70 --backend SYCL \
//     --runtime llama.cpp --model-name "Qwen3.8-27B" \
//     --context-length 65536 --concurrency 8 --prompt-tokens 7936

const fs = require('node:fs');
const { parseArgs } = require('node:util');

const TOLERANCE_FRACTION = 0.02;
const TOLERANCE_FLOOR = 8;

function main() {
  const { values: v } = parseArgs({
    options: {
      file: { type: 'string' },
      card: { type: 'string' },
      backend: { type: 'string' },
      runtime: { type: 'string' },
      'model-name': { type: 'string' },
      'context-length': { type: 'string' },
      concurrency: { type: 'string' },
      'prompt-tokens': { type: 'string' },
    },
  });

  if (!v.file || !fs.existsSync(v.file)) process.exit(1);

  const target = Number(v['prompt-tokens']);
  const tolerance = Math.max(TOLERANCE_FLOOR, target * TOLERANCE_FRACTION);

  const lines = fs.readFileSync(v.file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      continue; // a truncated final line is exactly what a crashed sweep leaves
    }
    if (
      row.card === v.card &&
      row.backend === v.backend &&
      row.runtime === v.runtime &&
      row.model_name === v['model-name'] &&
      Number(row.context_length) === Number(v['context-length']) &&
      Number(row.concurrency) === Number(v.concurrency) &&
      row.prompt_tokens !== null &&
      row.prompt_tokens !== undefined &&
      Math.abs(Number(row.prompt_tokens) - target) <= tolerance
    ) {
      process.exit(0);
    }
  }
  process.exit(1);
}

main();
