#!/usr/bin/env node
// Fires N concurrent completion requests at a running llama-server for a
// fixed duration, then derives aggregate tok/s from the server's own
// /metrics endpoint (Prometheus text format) — falls back to client-side
// timing if the expected counters aren't found, since llama-server's exact
// metric names have drifted across versions and shouldn't hard-fail a run.
//
// "Aggregate" is load-bearing: generation_tok_s is tokens produced per second
// of WALL time, summed across all slots, so it is comparable across a
// concurrency sweep and against vLLM's `output_throughput`. It deliberately
// does NOT use llama-server's own seconds counter — that accumulates per-slot
// generation time, which overlaps in wall time under concurrency, so
// tokens/seconds yields a mean per-slot rate instead. That per-slot rate is
// still reported separately as per_slot_generation_tok_s, since it is a
// useful number in its own right; it just isn't the headline one.
//
// Usage:
//   node load-llamacpp.js --base-url http://localhost:8080 \
//     --concurrency 8 --duration 20 --max-tokens 256 \
//     [--prompt-tokens 8192] [--prompt "..."] [--prompt-file prompts.txt]
//
// Prints one JSON object to stdout (and nothing else — the caller appends
// stdout straight to a repeats log, so warnings go to stderr):
//   { generation_tok_s, per_slot_generation_tok_s, prompt_eval_tok_s,
//     prompt_tokens, source: "metrics"|"client-timing",
//     requests_completed, requests_failed, wall_seconds }

const { parseArgs } = require('node:util');
const fs = require('node:fs');

function parseArgv() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://localhost:8080' },
      concurrency: { type: 'string', default: '1' },
      duration: { type: 'string', default: '20' },
      // Matches the runner's default. Short generations don't reach
      // steady-state decode — the window ends up dominated by scheduling and
      // the first-token path rather than the throughput being measured.
      'max-tokens': { type: 'string', default: '256' },
      prompt: { type: 'string' },
      'prompt-file': { type: 'string' },
      'prompt-tokens': { type: 'string' },
    },
  });
  return {
    baseUrl: values['base-url'].replace(/\/$/, ''),
    concurrency: parseInt(values.concurrency, 10),
    durationSec: parseFloat(values.duration),
    maxTokens: parseInt(values['max-tokens'], 10),
    promptTokens: values['prompt-tokens'] ? parseInt(values['prompt-tokens'], 10) : null,
    prompt: values.prompt,
    promptFile: values['prompt-file'],
  };
}

// The prompt pool must be big enough that no two requests in flight at the
// same moment share a prompt — otherwise prefix caching collapses them and
// the high-concurrency numbers come out inflated. Workers are also given
// staggered start offsets (see runWorker) so they don't advance in lockstep
// through a pool that is nominally large enough.
const MIN_POOL_SIZE = 8;
function poolSizeFor(concurrency) {
  return Math.max(MIN_POOL_SIZE, concurrency * 2);
}

function loadPrompts(prompt, promptFile) {
  if (promptFile) {
    const text = fs.readFileSync(promptFile, 'utf8');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines;
  }
  if (prompt) return [prompt];
  // Small default prompt pool so a bare invocation still works. The real
  // sweep always passes --prompt-tokens and gets the calibrated pool below
  // instead; this one is too small to keep concurrent requests distinct much
  // past concurrency 4, which is fine for an ad-hoc invocation and not fine
  // for a benchmark.
  return [
    'Explain the difference between a mutex and a semaphore in concurrent programming.',
    'Write a short story about a lighthouse keeper who discovers something strange in the fog.',
    'Summarize the likely causes behind the fall of the Roman Empire in a few paragraphs.',
    'Describe how a hash table resolves collisions, comparing chaining and open addressing.',
  ];
}

// --- Synthetic prompts of a target length (the prefill axis) ---
//
// A prefill sweep needs prompts of a known token length, which no fixed pool
// of English sentences can give. These are built from a small vocabulary
// instead, then calibrated against the server's own tokenizer — guessing from
// a words-per-token ratio alone drifts badly at 8k tokens and across models.

const FILLER_VOCAB = (
  'system memory buffer kernel driver latency throughput scheduler pipeline ' +
  'tensor matrix vector gradient parameter checkpoint inference training batch ' +
  'network protocol packet routing cluster storage index partition replica quorum ' +
  'analysis measurement baseline variance interval estimate threshold boundary ' +
  'process thread signal handler context register allocation fragment offset'
).split(' ');

// Deterministic PRNG so a rerun of the same cell sends the same prompts —
// benchmark inputs shouldn't vary run to run.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Each pool entry gets its own seed, so entries diverge at the very first
// word — no shared prefix for prefix caching to collapse them onto.
function makeFiller(seed, wordCount) {
  const rand = lcg(seed);
  const words = new Array(wordCount);
  for (let i = 0; i < wordCount; i += 1) {
    words[i] = FILLER_VOCAB[Math.floor(rand() * FILLER_VOCAB.length)];
  }
  return words.join(' ');
}

async function tokenCount(baseUrl, text) {
  try {
    const res = await fetch(`${baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.tokens) ? body.tokens.length : null;
  } catch (err) {
    return null;
  }
}

// Rough starting point only — the /tokenize loop below corrects it. Used as
// the final answer only when /tokenize isn't available, mirroring how
// /metrics degrades to client-side timing rather than hard-failing.
const TOKENS_PER_WORD = 0.75;
const CALIBRATION_PASSES = 4;
const CALIBRATION_TOLERANCE = 0.02;

async function buildCalibratedPrompt(baseUrl, seed, targetTokens) {
  let words = Math.max(1, Math.round(targetTokens / TOKENS_PER_WORD));
  let text = makeFiller(seed, words);
  let measured = null;

  for (let pass = 0; pass < CALIBRATION_PASSES; pass += 1) {
    measured = await tokenCount(baseUrl, text);
    if (measured === null) return { text, words, measured: null };
    if (Math.abs(measured - targetTokens) <= Math.max(2, targetTokens * CALIBRATION_TOLERANCE)) {
      return { text, words, measured };
    }
    words = Math.max(1, Math.round(words * (targetTokens / measured)));
    text = makeFiller(seed, words);
  }

  return { text, words, measured: await tokenCount(baseUrl, text) };
}

// Calibrate once, then reuse the word count for the rest of the pool, checking
// each entry with a single /tokenize call rather than re-deriving it from
// scratch. The pool is now sized to concurrency, so full calibration per entry
// would be up to 4x poolSize round trips of an 8k-token prompt on every
// repeat of every cell — real time spent before the measurement even starts.
// The vocabulary is uniform, so entries at the same word count land within
// the same tolerance the calibration loop was aiming at anyway, and what gets
// recorded is the measured length regardless.
async function buildPromptPool(baseUrl, targetTokens, poolSize) {
  const first = await buildCalibratedPrompt(baseUrl, 7919, targetTokens);
  const built = [first];

  for (let i = 1; i < poolSize; i += 1) {
    const text = makeFiller((i + 1) * 7919, first.words);
    built.push({ text, words: first.words, measured: await tokenCount(baseUrl, text) });
  }

  if (built.every((b) => b.measured === null)) {
    console.error(
      `load-llamacpp.js: /tokenize unavailable — prompt lengths fall back to a ` +
        `${TOKENS_PER_WORD} tokens/word estimate and may miss the ${targetTokens}-token target.`
    );
  } else {
    // The reused word count could still drift out of tolerance for some
    // entries if the vocabulary happened to be less uniform than assumed.
    // Say so rather than letting the prefill axis quietly widen.
    const tolerance = Math.max(2, targetTokens * CALIBRATION_TOLERANCE);
    const outOfRange = built.filter(
      (b) => b.measured !== null && Math.abs(b.measured - targetTokens) > tolerance
    );
    if (outOfRange.length > 0) {
      const lengths = outOfRange.map((b) => b.measured).join(', ');
      console.error(
        `load-llamacpp.js: ${outOfRange.length}/${poolSize} pool entries fell ` +
          `outside +/-${Math.round(tolerance)} tokens of the ${targetTokens}-token ` +
          `target (${lengths}). Recorded prompt_tokens is the measured mean.`
      );
    }
  }
  return built.map((b) => b.text);
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
const GEN_TOKENS_KEYS = ['llamacpp:tokens_predicted_total'];
const PROMPT_TOKENS_KEYS = ['llamacpp:prompt_tokens_total'];
// Per-slot generation time — accumulates across overlapping slots, so it is
// only ever used for the per-slot rate, never for the aggregate one.
const GEN_SECONDS_KEYS = [
  'llamacpp:tokens_predicted_seconds_total',
  'llamacpp:t_token_generation_total',
];
// Prefill time. Unlike generation, this is the right denominator for prefill
// throughput: it measures time actually spent processing prompts, which is
// what "prompt eval tok/s" means, and is the same quantity the vLLM side now
// derives from TTFT.
const PROMPT_SECONDS_KEYS = [
  'llamacpp:prompt_seconds_total',
  'llamacpp:t_prompt_processing_total',
];

// Delta of the first counter present under any of the given alias names.
// Returns null when no alias is present in both snapshots, or the counter
// didn't move (a reset, or nothing was served).
function counterDelta(before, after, keys) {
  for (const key of keys) {
    if (key in before && key in after) {
      const delta = after[key] - before[key];
      if (delta > 0) return delta;
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

// startIndex staggers each worker into a different part of the pool. Without
// it every worker starts at 0 and advances in step, so all N in-flight
// requests carry the same prompt and prefix caching serves N-1 of them from
// cache — which shows up as a throughput number that rises with concurrency
// for the wrong reason.
async function runWorker(baseUrl, prompts, maxTokens, deadline, results, startIndex) {
  let i = startIndex;
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
  const { baseUrl, concurrency, durationSec, maxTokens, promptTokens, prompt, promptFile } =
    parseArgv();

  // --prompt-tokens wins over --prompt/--prompt-file: a caller asking for a
  // specific prefill length can't also be handed prompts of another length.
  const prompts = promptTokens
    ? await buildPromptPool(baseUrl, promptTokens, poolSizeFor(concurrency))
    : loadPrompts(prompt, promptFile);

  if (prompts.length < concurrency) {
    console.error(
      `load-llamacpp.js: prompt pool holds ${prompts.length} entries but ` +
        `concurrency is ${concurrency} — some concurrent requests will share a ` +
        `prompt and may be served from the prefix cache.`
    );
  }

  const before = await fetchMetrics(baseUrl);

  const wallStart = Date.now();
  const deadline = wallStart + durationSec * 1000;
  const results = [];
  const workers = Array.from({ length: concurrency }, (_, w) =>
    runWorker(baseUrl, prompts, maxTokens, deadline, results, w)
  );
  await Promise.all(workers);
  const wallSeconds = (Date.now() - wallStart) / 1000;

  const after = await fetchMetrics(baseUrl);

  const completed = results.filter((r) => r.ok);
  const failed = results.length - completed.length;

  let generationTokS = null;
  let perSlotGenerationTokS = null;
  let promptEvalTokS = null;
  let source = 'client-timing';

  if (before && after) {
    // Aggregate decode throughput: server-side token count (accurate) over the
    // client's wall-clock window (the only denominator that stays meaningful
    // as slots overlap). Same quantity as vLLM's `output_throughput`.
    const genTokens = counterDelta(before, after, GEN_TOKENS_KEYS);
    if (genTokens !== null && wallSeconds > 0) {
      generationTokS = genTokens / wallSeconds;
      source = 'metrics';
    }

    // Per-slot decode rate, reported alongside rather than instead of the
    // aggregate. Both counters are per-slot sums, so their ratio is a mean
    // rate per slot and is roughly flat across the concurrency sweep.
    const genSeconds = counterDelta(before, after, GEN_SECONDS_KEYS);
    if (genTokens !== null && genSeconds !== null) {
      perSlotGenerationTokS = genTokens / genSeconds;
    }

    // Prefill throughput: prompt tokens over time actually spent prefilling.
    const promptTokensDelta = counterDelta(before, after, PROMPT_TOKENS_KEYS);
    const promptSeconds = counterDelta(before, after, PROMPT_SECONDS_KEYS);
    if (promptTokensDelta !== null && promptSeconds !== null) {
      promptEvalTokS = promptTokensDelta / promptSeconds;
    }
  }

  if (generationTokS === null) {
    // Fallback: client-observed tokens over the same wall-clock window. Less
    // precise than the server's own counter (it includes HTTP overhead and
    // misses tokens from requests still in flight), but it measures the same
    // aggregate quantity, so a fallback row is comparable to a /metrics row
    // rather than silently meaning something else.
    const totalGenerated = completed.reduce((sum, r) => sum + (r.generatedTokens || 0), 0);
    generationTokS = wallSeconds > 0 ? totalGenerated / wallSeconds : null;
  }
  if (promptEvalTokS === null) {
    // No prefill-time counter available. There is no client-side substitute:
    // wall time here covers decode too, so dividing by it would report a
    // number that falls as output length rises. Report the absence instead.
    promptEvalTokS = null;
  }

  // Prefill length actually sent, per request, as the server counted it —
  // the recorded value for the prefill axis, since calibration lands near
  // the target rather than exactly on it.
  const promptLengths = completed.map((r) => r.promptTokens).filter((n) => n > 0);
  const meanPromptTokens = promptLengths.length
    ? promptLengths.reduce((a, b) => a + b, 0) / promptLengths.length
    : null;

  console.log(
    JSON.stringify({
      generation_tok_s: generationTokS,
      per_slot_generation_tok_s: perSlotGenerationTokS,
      prompt_eval_tok_s: promptEvalTokS,
      prompt_tokens: meanPromptTokens,
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
