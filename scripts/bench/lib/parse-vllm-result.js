#!/usr/bin/env node
// Parses a `vllm bench serve --save-result --result-filename <file>` JSON
// output file and extracts aggregate tok/s. Field names have shifted across
// vLLM versions, so this tries a few known shapes and computes from raw
// token counts + duration when a named throughput field isn't present,
// rather than hard-failing on a version mismatch.
//
// The two throughput numbers are deliberately different shapes, matching what
// lib/load-llamacpp.js reports on the llama.cpp side:
//   generation_tok_s  — AGGREGATE decode tokens per second of wall time
//                       (vLLM's own `output_throughput`).
//   prompt_eval_tok_s — prefill tokens per second of PREFILL time, derived
//                       from TTFT. Not over benchmark duration: that includes
//                       decode, so the value would sink as output length rose.
//
// Usage: node parse-vllm-result.js <result.json>
// Prints: { generation_tok_s, per_slot_generation_tok_s, prompt_eval_tok_s,
//           prompt_tokens, source, prompt_eval_source, requests_completed }

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
        per_slot_generation_tok_s: null,
        prompt_eval_tok_s: null,
        prompt_tokens: null,
        source: 'unreadable',
        prompt_eval_source: 'unreadable',
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

  // Mean per-request decode rate, the counterpart to llama.cpp's
  // per_slot_generation_tok_s. TPOT is time per output token, so its
  // reciprocal is that request's decode rate.
  const meanTpotMs = firstDefined(data, ['mean_tpot_ms', 'mean_tpot']);
  const perSlotGenerationTokS = meanTpotMs ? 1000 / meanTpotMs : null;

  // Mean prefill length actually sent. --random-input-len is a target, not a
  // guarantee (the sampler lands near it, not on it), so report what the run
  // reports rather than echoing the flag back.
  const completed = firstDefined(data, ['completed']) ?? null;
  const totalInput = firstDefined(data, ['total_input_tokens']);
  const promptTokens =
    totalInput !== undefined && completed ? totalInput / completed : null;

  // Prefill throughput from TTFT. `input_throughput` and
  // total_input_tokens/duration are both input tokens per second of *benchmark*,
  // which includes all the decode time — not prefill speed, and it drops as
  // --random-output-len rises. TTFT is the closest thing vLLM reports to
  // prefill time.
  //
  // Caveat, deliberately not corrected for: under concurrency TTFT includes
  // queue wait ahead of prefill, so this understates prefill throughput as
  // concurrency rises. It is exact at concurrency 1. Understating is the safe
  // direction, and there is no queue-time field to subtract.
  let promptEvalTokS = null;
  let promptEvalSource = 'unavailable';
  const meanTtftMs = firstDefined(data, ['mean_ttft_ms', 'mean_ttft']);
  if (meanTtftMs && promptTokens) {
    promptEvalTokS = promptTokens / (meanTtftMs / 1000);
    promptEvalSource = 'ttft';
  }

  console.log(
    JSON.stringify({
      generation_tok_s: generationTokS ?? 0,
      per_slot_generation_tok_s: perSlotGenerationTokS,
      prompt_eval_tok_s: promptEvalTokS,
      prompt_tokens: promptTokens,
      source,
      prompt_eval_source: promptEvalSource,
      requests_completed: completed,
    })
  );
}

main();
