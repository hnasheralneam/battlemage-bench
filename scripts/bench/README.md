# Benchmark runner

Runs the test matrix described on the site's [Methodology](/methodology)
page and produces submission-ready rows for Battlemage Benchmarks.

## One-time setup

1. **llama.cpp**: edit `llama-server-launch.vulkan.sh` and
   `llama-server-launch.sycl.sh` — set `LLAMACPP_VULKAN_DIR`/
   `LLAMACPP_SYCL_DIR` (or export them in your shell) to your two separate
   llama.cpp checkouts, and adjust any of the tuned flags (ctx-size,
   batch/ubatch size, KV cache quant, sampling params, etc.) to match your
   own setup. These flags are edited directly in the files, not passed
   through as CLI options, since they're tuned per-hardware.
2. **vLLM**: `vllm-serve-launch.sh` is a **placeholder** — it has never been
   run against your real environment. Fill in `VLLM_ENV_ACTIVATE` and any
   `VLLM_EXTRA_ARGS` before using `run-vllm.sh`/`run-matrix.sh` for real.
3. Both launch scripts assume `--metrics`/health endpoints are reachable at
   `localhost:<port>` — no extra firewall config needed for local use.

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

Both default to `--concurrency-levels 1,2,4,8,16 --repeats 3` and append to
a fresh `results/<timestamp>.jsonl`. Run `--help` on either for the full
flag list.

## Running the whole matrix

```bash
./run-matrix.sh \
  --llamacpp-model-path /path/to/model.gguf --llamacpp-model-name "My-Model" --llamacpp-quantization Q4_K_M \
  --vllm-model /path/or/hf-id --vllm-model-name "My-Model" --vllm-quantization AWQ-4bit
```

Walks every cell in `matrix.json` (3 runtime×backend combos × 2 cards),
pausing before each card switch to ask you to confirm the right physical
GPU is active — this is **never auto-detected**. All cells append to one
shared results file.

Add/remove cells (e.g. a future vLLM+Vulkan) by editing `matrix.json`, not
the scripts.

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

Each concurrency level runs 3 times; the first run is discarded as a
warmup and the reported `generation_tok_s`/`prompt_eval_tok_s` is the
**median** of the rest (`lib/emit-submission.js`). All raw per-repeat
output is kept in the submission's `raw_log`, not just the median.

- **llama.cpp**: throughput is read from `llama-server`'s own `/metrics`
  Prometheus counters (before/after delta across the load window,
  `lib/load-llamacpp.js`) — falls back to client-side wall-clock timing if
  the expected counter names aren't found (they've drifted across llama.cpp
  versions before).
- **vLLM**: parsed from `vllm bench serve --save-result`'s JSON output
  (`lib/parse-vllm-result.js`), with the same kind of field-name fallback.

## Files

| File | Purpose |
|---|---|
| `matrix.json` | declarative list of {card, backend, runtime} cells + defaults |
| `collect-system-info.sh` | caches OS/kernel/driver/SDK info once per session |
| `llama-server-launch.{vulkan,sycl}.sh` | tuned server launch commands, edited directly |
| `vllm-serve-launch.sh` | vLLM server launch — **placeholder, needs filling in** |
| `run-llamacpp.sh` / `run-vllm.sh` | per-runtime sweep orchestrators |
| `run-matrix.sh` | walks the whole matrix, prompts on card switches |
| `lib/load-llamacpp.js` | concurrent-request load generator + /metrics parsing |
| `lib/parse-vllm-result.js` | parses `vllm bench serve` JSON output |
| `lib/emit-submission.js` | repeats → median → schema-shaped JSONL row |
| `submit-jsonl.js` | POSTs a JSONL file's rows to the site's `/submit` |
