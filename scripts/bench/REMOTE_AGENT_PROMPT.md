# Running the Battlemage Benchmarks sweep

You are on the machine that physically has the Intel Arc GPU(s). Your job is
to run the benchmark matrix and hand the results back.

This is a long job — a full three-model sweep is thousands of timed runs and
well over a day of wall time. Most of the ways it goes wrong are cheap to
catch in the first ten minutes and expensive to catch in hour nine, which is
what the preflight below is for. **Do not skip it, and do not start the full
sweep until every preflight check passes.**

## What you have

- `scripts/bench/` — the runner. Read `scripts/bench/README.md` for the full
  picture.
- `recipes/` — the launch scripts. **These are not optional and not
  reference material**: the runner sources them for every flag it does not
  itself sweep. Without this directory nothing starts.
- `docs/SETUP.md` — how the machine is supposed to be set up, with a command
  that proves each part. Your preflight is that document's checklist.

The short version of how the runner works:

- `run-llamacpp.sh` / `run-vllm.sh` sweep three crossed axes — context length
  (8K/64K/128K), concurrency (1, 2, 4, 8, 16) and prefill length (256/7936
  prompt tokens) — with 4 repeats per cell. The first repeat is discarded as
  warmup and the published figure is the median of the remaining three.
- Every flag except those axes comes from a named recipe, so each row records
  which recipe produced it and a reader can reproduce it exactly.
- `run-matrix.sh` runs every applicable cell in one go, pausing before each
  card switch to have you confirm the right physical GPU is active.
- Nothing auto-detects the GPU or scans for models. You supply real paths, and
  you are responsible for the card label being true.

## Preflight — report the output of all of these before running anything

Work through `docs/SETUP.md` and run its checklist. At minimum, confirm and
report:

1. **Card.** `xpu-smi discovery`. Which card(s) are present, and which one
   this sweep will label its results with. If both are installed, show how you
   pinned one (`ONEAPI_DEVICE_SELECTOR`) and re-confirm afterwards.
2. **Both llama.cpp builds.** `llama-server --version` from the Vulkan
   checkout and from the SYCL checkout (the latter after sourcing oneAPI).
   Two separate directories — if there is only one, stop and ask.
3. **vLLM XPU.** `python -c "import vllm; print(vllm.__version__)"` after
   activating the environment, and one `vllm serve --device xpu` reaching
   `/health`. **Do this before the llama.cpp sweep, not after.** A third of
   the matrix runs through vLLM and it is the least proven part of the stack;
   finding out it doesn't start after the llama.cpp half has already run
   wastes most of a day.
4. **Models.** `ls -lh` each file you will benchmark. Verify the exact
   repository and filename rather than assuming a naming convention — quant
   filenames differ between publishers, and a sweep that ran a different quant
   than it recorded is worse than no sweep. The three models are in the table
   below; confirm the paths with the operator if anything is ambiguous.
5. **System info cached.** `./scripts/bench/collect-system-info.sh`, then show
   `scripts/bench/cache/system-info.json`.
6. **Smoke cell per runtime and backend.** Three cheap cells, one per
   runtime×backend combination:

   ```bash
   ./run-llamacpp.sh --backend Vulkan --card <CARD> \
     --model-path <path> --model-name "Qwen3.8-27B" --quantization Q4_K_M \
     --concurrency-levels 1 --ctx-sizes 8192 --prefill-lengths 256 \
     --repeats 1 --duration 10
   # then the same with --backend SYCL, and:
   ./run-vllm.sh --card <CARD> \
     --model <path-or-id> --model-name "Qwen3.8-27B" --quantization AWQ-4bit \
     --concurrency-levels 1 --max-model-lens 8192 --prefill-lengths 256 \
     --repeats 1 --duration 10
   ```

   For each, check the emitted row before moving on:
   - `generation_tok_s` is a plausible non-zero number, and `crashed` is 0.
   - the printed `prefill=` is close to 256. If prompt calibration cannot
     reach the server's `/tokenize` endpoint the script warns on stderr and
     prompt lengths will be wrong — that warning is a stop condition, not a
     nuisance.
   - `recipe` and `kv_cache_type` are populated, not null.

## The models

Three models, each across the full matrix. Run them one at a time, each to its
own results file.

| Model | Architecture | llama.cpp | vLLM |
|---|---|---|---|
| Qwen3.8-27B | 27B dense | GGUF, Q4_K_M | AWQ-4bit |
| Qwen3.6-35B-A3B | 35B MoE, ~3B active | GGUF, Q4_K_M | AWQ-4bit |
| Muse-Glimmer-30B | 30B dense | GGUF, Q4_K_M | AWQ-4bit |

Use those exact `--model-name` spellings so results group with the rest of the
data. Model and quant are **not** forced to match between llama.cpp and vLLM —
the two runtimes load different artifacts entirely — but they must be held
constant for a given runtime across the whole sweep.

## Running the sweep

One command per model:

```bash
./run-matrix.sh --card <CARD> \
  --llamacpp-model-path <path/to/model.gguf> \
  --llamacpp-model-name "Qwen3.8-27B" --llamacpp-quantization Q4_K_M \
  --vllm-model <path-or-hf-id> \
  --vllm-model-name "Qwen3.8-27B" --vllm-quantization AWQ-4bit \
  --results-file results/qwen3.8-27b.jsonl
```

Then repeat with the other two models and their own `--results-file`.

Omit `--card` only if every card in `matrix.json` is physically present; the
script will pause and ask you to confirm before each card switch. If only one
card is installed, always pass `--card`.

### If it stops partway through

Re-run the identical command with `--resume` added, pointed at the same
`--results-file`. Cells already recorded there are skipped, including their
model load, which is most of the cost. Do not start a fresh results file to
"be safe" — that produces duplicate rows for the cells that did complete.

### Stop conditions

Stop and report rather than pushing through, if any of these happen:

- **A `/tokenize` calibration warning** on the llama.cpp side. Prompt lengths
  are then estimates, and the prefill axis stops measuring what it records.
- **Repeated server health-check timeouts** — more than a couple of context
  levels in a row failing to come up. One is a result; a run of them means the
  environment is broken, and every subsequent row will be a false `crashed=1`.
- **OOM.** Note which model, recipe and context level, and stop that model's
  sweep. A card that cannot hold the configuration is worth reporting, but
  continuing produces a page of identical failures rather than information.
- **A runtime version that changed mid-sweep** (a rebuild, an environment
  switch). The rows before and after are no longer one dataset.
- **Anything requiring you to edit files outside `scripts/bench/`.** See the
  guardrails.

A single crashed cell is not a stop condition — the runner records it as
`crashed=1` with a null throughput and carries on. That is a real result.

## Handing the results back

For each model's results file:

- Print the full contents wrapped exactly like this so it can be extracted
  mechanically:

  ```
  ===BEGIN RESULTS JSONL===
  <full file contents, one JSON object per line>
  ===END RESULTS JSONL===
  ```

- Give a short plain-English summary: which cells ran clean, which came back
  `crashed=1` and why, the rough tok/s range per runtime and backend, and
  anything that surprised you.
- Report the preflight output alongside it, so the versions the rows claim can
  be checked against what was actually installed.

If — and only if — you and the operator both know this machine can reach the
site host over the network, you can submit directly to the pending queue
instead of relaying by hand:

```bash
node submit-jsonl.js --file results/<file>.jsonl --dry-run   # check first
node submit-jsonl.js --file results/<file>.jsonl --base-url http://<site-host>:3000
```

Do not guess at a URL. Every row lands as `pending` either way and still needs
manual approval at `/admin` before it appears publicly.

## Guardrails

- **Don't modify anything outside `scripts/bench/`.** In particular, do not
  edit `recipes/` to make something work. The recipes are what the published
  numbers claim to have been measured with, so editing one silently breaks
  that claim. If a recipe will not run as written, that is a finding — report
  it.
- **Don't invent** model paths, driver versions, or vLLM flags you have not
  verified on this machine. Ask the operator.
- **Don't build llama.cpp or install vLLM from scratch** as a workaround for
  something missing. Stop and ask.
- **Don't relabel a card to make a sweep complete.** The card field is the one
  thing on every row that nothing can verify after the fact.
