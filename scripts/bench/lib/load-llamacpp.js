#!/usr/bin/env node
// Fires N concurrent completion requests at a running llama-server for a
// fixed duration, then derives aggregate tok/s from the server's own
// /metrics endpoint (Prometheus text format) — falls back to client-side
// timing if the expected counters aren't found, since llama-server's exact
// metric names have drifted across versions and shouldn't hard-fail a run.
//
// Usage:
//   node load-llamacpp.js --base-url http://localhost:8080 \
//     --concurrency 8 --duration 20 --max-tokens 128 \
//     [--prompt "..."] [--prompt-file prompts.txt]
//
// Prints one JSON object to stdout:
//   { generation_tok_s, prompt_eval_tok_s, source: "metrics"|"client-timing",
//     requests_completed, requests_failed, wall_seconds }

const { parseArgs } = require('node:util');
const fs = require('node:fs');

function parseArgv() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://localhost:8080' },
      concurrency: { type: 'string', default: '1' },
      duration: { type: 'string', default: '20' },
      'max-tokens': { type: 'string', default: '128' },
      prompt: { type: 'string' },
      'prompt-file': { type: 'string' },
    },
  });
  return {
    baseUrl: values['base-url'].replace(/\/$/, ''),
    concurrency: parseInt(values.concurrency, 10),
    durationSec: parseFloat(values.duration),
    maxTokens: parseInt(values['max-tokens'], 10),
    prompts: loadPrompts(values.prompt, values['prompt-file']),
  };
}

function loadPrompts(prompt, promptFile) {
  if (promptFile) {
    const text = fs.readFileSync(promptFile, 'utf8');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (prompt) return [prompt];
  // Small default prompt pool so a bare invocation still works — varied
  // enough that KV-cache/prefix caching doesn't trivially collapse every
  // request to the same cached prefix.
  return [
    'Explain the difference between a mutex and a semaphore in concurrent programming.',
    'Write a short story about a lighthouse keeper who discovers something strange in the fog.',
    'Summarize the likely causes behind the fall of the Roman Empire in a few paragraphs.',
    'Describe how a hash table resolves collisions, comparing chaining and open addressing.',
  ];
}

// --- Prometheus text-format parsing ---
function parseMetrics(text) {
  const metrics = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9eE+\-.]+)\s*$/);
    if (!match) continue;
    const [, name, , valueStr] = match;
    const value = Number(valueStr);
    if (!Number.isFinite(value)) continue;
    // Sum across label variants sharing the same base metric name — we only
    // care about the aggregate total for this metric across the server.
    metrics[name] = (metrics[name] || 0) + value;
  }
  return metrics;
}

async function fetchMetrics(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/metrics`);
    if (!res.ok) return null;
    return parseMetrics(await res.text());
  } catch (err) {
    return null;
  }
}

// Candidate metric name pairs to try, in order — llama-server's exact names
// have changed across versions, so this tries a few known shapes instead of
// hard-failing on the first mismatch.
const GEN_METRIC_CANDIDATES = [
  ['llamacpp:tokens_predicted_total', 'llamacpp:tokens_predicted_seconds_total'],
  ['llamacpp:tokens_predicted_total', 'llamacpp:t_token_generation_total'],
];
const PROMPT_METRIC_CANDIDATES = [
  ['llamacpp:prompt_tokens_total', 'llamacpp:prompt_seconds_total'],
  ['llamacpp:prompt_tokens_total', 'llamacpp:t_prompt_processing_total'],
];

function deriveFromCandidates(before, after, candidates) {
  for (const [tokensKey, secondsKey] of candidates) {
    if (tokensKey in before && tokensKey in after && secondsKey in before && secondsKey in after) {
      const dTokens = after[tokensKey] - before[tokensKey];
      const dSeconds = after[secondsKey] - before[secondsKey];
      if (dTokens > 0 && dSeconds > 0) {
        return dTokens / dSeconds;
      }
    }
  }
  return null;
}

// --- Load generation ---
async function sendCompletion(baseUrl, prompt, maxTokens) {
  const res = await fetch(`${baseUrl}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, n_predict: maxTokens, stream: false }),
  });
  if (!res.ok) return { ok: false };
  const body = await res.json();
  const timings = body.timings || {};
  return {
    ok: true,
    promptTokens: timings.prompt_n ?? body.tokens_evaluated ?? 0,
    generatedTokens: timings.predicted_n ?? body.tokens_predicted ?? 0,
  };
}

async function runWorker(baseUrl, prompts, maxTokens, deadline, results) {
  let i = 0;
  while (Date.now() < deadline) {
    const prompt = prompts[i % prompts.length];
    i += 1;
    try {
      results.push(await sendCompletion(baseUrl, prompt, maxTokens));
    } catch (err) {
      results.push({ ok: false, error: String(err) });
    }
  }
}

async function main() {
  const { baseUrl, concurrency, durationSec, maxTokens, prompts } = parseArgv();

  const before = await fetchMetrics(baseUrl);

  const wallStart = Date.now();
  const deadline = wallStart + durationSec * 1000;
  const results = [];
  const workers = Array.from({ length: concurrency }, () =>
    runWorker(baseUrl, prompts, maxTokens, deadline, results)
  );
  await Promise.all(workers);
  const wallSeconds = (Date.now() - wallStart) / 1000;

  const after = await fetchMetrics(baseUrl);

  const completed = results.filter((r) => r.ok);
  const failed = results.length - completed.length;

  let generationTokS = null;
  let promptEvalTokS = null;
  let source = 'client-timing';

  if (before && after) {
    generationTokS = deriveFromCandidates(before, after, GEN_METRIC_CANDIDATES);
    promptEvalTokS = deriveFromCandidates(before, after, PROMPT_METRIC_CANDIDATES);
    if (generationTokS !== null) source = 'metrics';
  }

  if (generationTokS === null) {
    // Fallback: aggregate client-observed tokens over the wall-clock window.
    // Less precise than the server's own counters (includes HTTP overhead,
    // and per-request wall time overlaps under concurrency rather than
    // summing cleanly), but always available even if /metrics is disabled
    // or its field names don't match what's expected above.
    const totalGenerated = completed.reduce((sum, r) => sum + (r.generatedTokens || 0), 0);
    generationTokS = wallSeconds > 0 ? totalGenerated / wallSeconds : null;
  }
  if (promptEvalTokS === null) {
    const totalPrompt = completed.reduce((sum, r) => sum + (r.promptTokens || 0), 0);
    promptEvalTokS = wallSeconds > 0 ? totalPrompt / wallSeconds : null;
  }

  console.log(
    JSON.stringify({
      generation_tok_s: generationTokS,
      prompt_eval_tok_s: promptEvalTokS,
      source,
      requests_completed: completed.length,
      requests_failed: failed,
      wall_seconds: wallSeconds,
    })
  );
}

main().catch((err) => {
  console.error('load-llamacpp.js failed:', err);
  process.exit(1);
});
