#!/usr/bin/env node
// Parses a `vllm bench serve --save-result --result-filename <file>` JSON
// output file and extracts aggregate tok/s. Field names have shifted across
// vLLM versions, so this tries a few known shapes and computes from raw
// token counts + duration when a named throughput field isn't present,
// rather than hard-failing on a version mismatch.
//
// Usage: node parse-vllm-result.js <result.json>
// Prints: { generation_tok_s, prompt_eval_tok_s, source, requests_completed }

const fs = require('node:fs');

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node parse-vllm-result.js <result.json>');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Missing/unreadable result file (e.g. `vllm bench serve` itself
    // failed) — report as a zero-throughput repeat rather than crashing the
    // whole sweep; run-vllm.sh's crashed-detection picks this up via
    // requests_completed.
    console.log(
      JSON.stringify({
        generation_tok_s: 0,
        prompt_eval_tok_s: 0,
        source: 'unreadable',
        requests_completed: 0,
      })
    );
    return;
  }

  const duration = firstDefined(data, ['duration', 'benchmark_duration']);

  let generationTokS = firstDefined(data, ['output_throughput', 'output_token_throughput']);
  let source = generationTokS !== undefined ? 'named-field' : 'computed';
  if (generationTokS === undefined) {
    const totalOutput = firstDefined(data, ['total_output_tokens', 'total_generated_tokens']);
    generationTokS = totalOutput !== undefined && duration ? totalOutput / duration : null;
  }

  let promptEvalTokS = firstDefined(data, ['input_throughput', 'input_token_throughput']);
  if (promptEvalTokS === undefined) {
    const totalInput = firstDefined(data, ['total_input_tokens']);
    promptEvalTokS = totalInput !== undefined && duration ? totalInput / duration : null;
  }

  console.log(
    JSON.stringify({
      generation_tok_s: generationTokS ?? 0,
      prompt_eval_tok_s: promptEvalTokS ?? null,
      source,
      requests_completed: firstDefined(data, ['completed']) ?? null,
    })
  );
}

main();
