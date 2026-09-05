# Benchmark runner

Runs the test matrix described on the site's [Methodology](/methodology)
page and produces submission-ready rows for Battlemage Benchmarks.

## One-time setup

Full instructions, with a command that proves each step, are in
[`docs/SETUP.md`](../../docs/SETUP.md). The short version:

1. Two llama.cpp checkouts, one built for Vulkan and one for SYCL, at
   `$HOME/llama.cpp-vulkan` and `$HOME/llama.cpp-sycl` (or wherever
   `LLAMACPP_VULKAN_DIR` / `LLAMACPP_SYCL_DIR` point).
2. A Python environment with vLLM's XPU build, activatable at
   `$HOME/vllm-xpu/bin/activate` (or wherever `VLLM_ENV_ACTIVATE` points).
3. The models on disk, and `xpu-smi` available for power measurement.

**Tuning flags are not configured here.** They live in the recipes in
[`../../recipes`](../../recipes), which is where the site's launch
recommendations live and which the runner sources for every flag it does not
itself sweep. Benchmarking what the recipes actually say means a published
number and the script a reader copies can't drift apart. `--recipe` selects
one; the default is the `balanced` profile for the runtime and backend.

The launch wrappers here (`llama-server-launch.sh`, `vllm-serve-launch.sh`)
are thin: they source a recipe and override only the swept axes, the port and
model, greedy decoding, and `--metrics`. Both assume the server's health and
metrics endpoints are reachable at `localhost:<port>` — no firewall config
needed for local use.

## Running one runtime by itself

```bash
# llama.cpp, one backend+card, full concurrency sweep
./run-llamacpp.sh --backend Vulkan --card B70 \
  --model-path /path/to/model.gguf --model-name "My-Model" \
  --quantization Q4_K_M

# vLLM (SYCL/XPU only — no Vulkan variant)
./run-vllm.sh --card B70 \
  --model /path/or/hf-id --model-name "My-Model" \
  --quantization AWQ-4bit
```

Both default to `--concurrency-levels 1,2,4,8,16 --repeats 4` and append to
a fresh `results/<timestamp>.jsonl`. Run `--help` on either for the full
flag list.

## The three axes

Every cell is a (context length, concurrency, prefill length) triple, run
across each card/backend/runtime combo. Defaults live in `matrix.json`:

| Axis | Levels | Flag |
|---|---|---|
| Context (server KV budget) | 8192, 65536, 131072 | `--ctx-sizes` (llama.cpp) / `--max-model-lens` (vLLM) |
| Concurrency | 1, 2, 4, 8, 16 | `--concurrency-levels` |
| Prefill (prompt tokens/request) | 256, 7936 | `--prefill-lengths` |

Context and prefill are separate axes on purpose: context is VRAM the server
reserves whether or not it's used, prefill is what actually loads the prefill
path and moves `prompt_eval_tok_s`.

**Prefill is a controlled length, not a corpus.** llama.cpp prompts are
synthetic filler calibrated to the target token count against the server's
own `/tokenize` endpoint (`lib/load-llamacpp.js`); if `/tokenize` isn't
reachable the script warns on stderr and falls back to a words-per-token
estimate. Each pool entry is seeded differently, the pool is sized to at least
twice the concurrency level, and each worker starts at its own offset into it —
all three are needed so that no two requests in flight at the same moment
share a prompt. (They previously did: every worker started at index 0 of a
four-entry pool and advanced in lockstep, so prefix caching served most of a
concurrent batch from cache and inflated the high-concurrency numbers.) vLLM uses `vllm bench serve --dataset-name random
--random-input-len`, replacing its default dataset — whose prompt lengths
can't be swept and aren't comparable to the llama.cpp side. Either way the
recorded `prompt_tokens` is what the run *measured*, not the target it was
asked for.

### Skipped cells

A cell runs only if there's room for the prefill plus the 256 tokens it
generates: `context >= prefill + 256`, on both runtimes.

Concurrency does **not** enter the test on either side. On vLLM that is
because `--max-model-len` is a per-request ceiling. On llama.cpp it is because
the recipes launch with `-kvu` (unified KV cache), which makes `--ctx-size`
one shared budget rather than a total carved into fixed per-slot shares — so
adding parallel slots does not shrink each session's ceiling.

(This is a correction. The rule here used to be
`ctx / concurrency >= prefill + 128`, which is right for a *split* KV cache
and wrong for the unified one the recipes actually use — it was discarding
cells that run fine.)

With the default levels, and the long prefill at 7936 rather than 8192, every
combination fits: **30 of 30 cells per combo, 180 cells and 720 timed runs per
model** across all six combos, plus 66 server launches. For all three models
that is 540 cells, 2,160 timed runs and ~198 server launches. Model load on
Arc — especially first-run SYCL kernel JIT — is minutes rather than seconds,
so budget well over a day and use `--resume`.

Skipped cells, where a non-default axis produces one, are printed as they are
decided and listed again in an end-of-sweep summary. They emit **no**
submission row, since a truncated prompt would silently measure a different
prefill length than the one recorded.

(7936 rather than 8192 is deliberate: 8192 + 256 does not fit an 8192 context,
so a nominally round long prefill would drop that whole context level.)

### Resuming an interrupted sweep

Re-run the same command with `--resume` and the same `--results-file`. Cells
already present in that file are skipped before the server starts, so a
completed cell costs no model load — which is most of the wall time. Cells are
matched on card, backend, runtime, model, context, concurrency and prefill
(the last with a small tolerance, since the recorded prefill is what the run
measured rather than what it asked for).

Don't start a fresh results file after an interruption: the cells that did
complete would be run again and appear twice.

To sweep one axis on its own, pin the others:

```bash
# prefill sweep at a single context size and concurrency
./run-llamacpp.sh --backend SYCL --card B70 \
  --model-path /path/model.gguf --model-name "My-Model" --quantization Q4_K_M \
  --ctx-sizes 131072 --concurrency-levels 1 --prefill-lengths 256,1024,4096,8192
```

## Running the whole matrix — one model

```bash
./run-matrix.sh \
  --llamacpp-model-path /path/to/model.gguf --llamacpp-model-name "My-Model" --llamacpp-quantization Q4_K_M \
  --vllm-model /path/or/hf-id --vllm-model-name "My-Model" --vllm-quantization AWQ-4bit
```

Walks every cell in `matrix.json` (3 runtime×backend combos × 2 cards,
each swept across all three axes), pausing before each card switch to ask you to confirm the right physical
GPU is active — this is **never auto-detected**. All cells append to one
shared results file.

Add/remove cells (e.g. a future vLLM+Vulkan) by editing `matrix.json`, not
the scripts.

## Running the whole matrix — all three site models

`run-all.sh` wraps `run-matrix.sh` to run all three site models (see
`models.example.json`) across every card, card outermost, one results file
per (card, model). This is the entry point [`REMOTE_AGENT_PROMPT.md`](REMOTE_AGENT_PROMPT.md)
hands to whoever runs the sweep:

```bash
cp models.example.json models.json   # fill in real paths — gitignored
./run-all.sh
```

## Getting results onto the site

```bash
# sanity-check first — doesn't POST anything
node submit-jsonl.js --file results/<timestamp>.jsonl --dry-run

# actually submit — lands every row as `pending`, same as a manual submission
node submit-jsonl.js --file results/<timestamp>.jsonl --base-url http://localhost:3000
```

Every row — including these scripted ones — still needs manual approval via
`/admin` before it appears publicly.

## How a number gets computed

Each cell runs 4 times; the first is discarded as a warmup and the reported
`generation_tok_s`/`prompt_eval_tok_s`/`prompt_tokens` is the **median** of
the remaining three (`lib/emit-submission.js`). All raw per-repeat output is
kept in the submission's `raw_log`, not just the median.

Four, not three: with three repeats the median of the two scored runs is their
mean, which rejects no outliers at all while still being called a median. Four
is the smallest count that makes the word true.

Both runtimes report the same two quantities, which is what makes the
concurrency sweep mean anything:

- **`generation_tok_s` is aggregate** — output tokens per second of wall time,
  summed across all slots. It should climb with concurrency.
- **`prompt_eval_tok_s` is per second of prefill time**, not per second of
  benchmark. Dividing by total benchmark time would make it fall as output
  length rises, which is a property of the benchmark rather than the hardware.

Getting there differs by runtime:

- **llama.cpp**: the server's own `/metrics` token counter delta over the
  client's wall-clock window (`lib/load-llamacpp.js`). Deliberately *not* the
  ratio `tokens_predicted_total / tokens_predicted_seconds_total` — that
  seconds counter sums per-slot time, which overlaps in wall time, so the
  ratio is a mean per-slot rate rather than aggregate throughput. That
  per-slot rate is still reported, as `per_slot_generation_tok_s` in the raw
  log. Prefill throughput uses `prompt_tokens_total / prompt_seconds_total`,
  which is a true prefill-time denominator. Falls back to client-side timing
  for the aggregate figure if the counter names aren't found (they've drifted
  across llama.cpp versions before); the fallback measures the same quantity,
  so a fallback row stays comparable.
- **vLLM**: parsed from `vllm bench serve --save-result`'s JSON
  (`lib/parse-vllm-result.js`), with the same field-name fallbacks.
  `output_throughput` is already aggregate. Prefill throughput is derived from
  mean TTFT rather than from `input_throughput`, which is input tokens per
  second of benchmark and so has the problem described above. Under
  concurrency TTFT includes queue wait, so this understates prefill slightly —
  exact at concurrency 1, conservative above it.

Which path produced a row is recorded in its `notes`, not just its raw log.

## Files

| File | Purpose |
|---|---|
| `matrix.json` | declarative list of {card, backend, runtime} cells + the default levels for all three axes |
| `../../recipes/` | the launch flags themselves — sourced, not duplicated |
| `collect-system-info.sh` | caches OS/kernel/driver/SDK info once per session |
| `llama-server-launch.sh` | sources a recipe, overrides the swept axes, launches |
| `vllm-serve-launch.sh` | same, for vLLM |
| `run-llamacpp.sh` / `run-vllm.sh` | per-runtime sweep orchestrators |
| `run-matrix.sh` | walks the whole matrix for one model, prompts on card switches |
| `run-all.sh` | walks `run-matrix.sh` over every model in `models.json`, card outermost |
| `models.example.json` | template for `models.json` (gitignored, machine-specific paths) |
| `lib/load-llamacpp.js` | concurrent-request load generator, calibrated prompt lengths, /metrics parsing |
| `lib/parse-vllm-result.js` | parses `vllm bench serve` JSON output |
| `lib/emit-submission.js` | repeats → median → schema-shaped JSONL row |
| `lib/has-cell.js` | is this cell already in the results file? (`--resume`) |
| `lib/summarize-results.js` | plain-English per-file summary printed at the end of `run-all.sh` |
| `submit-jsonl.js` | POSTs a JSONL file's rows to the site's `/submit` |
