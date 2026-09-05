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
- `run-matrix.sh` runs every applicable cell in one go, for one model, pausing
  before each card switch to have you confirm the right physical GPU is
  active. `run-all.sh` wraps it to run all three site models in the right
  order — that's the one you'll actually invoke; see "Running the sweep".
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

Copy `scripts/bench/models.example.json` to `scripts/bench/models.json` and
fill in the three real model paths/quants (confirmed against the operator per
the preflight above — this file is gitignored, it's machine-specific). Then
one command runs the whole thing:

```bash
./run-all.sh
```

This walks all three models across every card in `matrix.json`, **card
outermost, largest context first**, into one results file per (card, model)
under `results/`. Both are deliberate:

- **Card is the outermost loop.** Confirming or physically swapping a card is
  a blocking manual step. Running model-by-model across both cards would hit
  it three times; finishing a card first hits it once. It also keeps one model
  in the page cache across all three of its runtime×backend combos, so its 15
  reloads come from RAM rather than disk.
- **Largest context first** (`131072,65536,8192`, `run-all.sh`'s default). If
  a model doesn't fit at 128K on this card, that fails on the very first
  server start rather than two-thirds of the way through the sweep. The axis
  order has no effect on the results, only on how early you find out.

It prompts once per card (physically swap or set the device selector, then
press Enter) and once more per model inside that as a lightweight
re-confirmation — that second one is not asking you to swap again, just to
double check the card didn't drift. At the end it prints a plain-English
summary and every results file already wrapped for the handoff below — see
"Handing the results back".

Pass `--card B70` to restrict to one card (do this if only one is physically
installed; `run-all.sh` will otherwise expect to pause for both). `--resume`
works the same way it does everywhere else in this runner — see below.

If you need one model or one runtime in isolation (re-running a single failed
combo, say), drop to `run-matrix.sh` / `run-llamacpp.sh` / `run-vllm.sh`
directly — see `README.md`. `run-all.sh` is a thin wrapper around
`run-matrix.sh`, not a replacement for it.

### Why llama.cpp is slower to sweep than vLLM

Expect the llama.cpp combos to spend far more time loading. `--parallel` is a
`llama-server` launch flag, so each concurrency level needs its own server —
15 starts per combo (3 contexts × 5 concurrency levels). vLLM's
`--max-concurrency` is a client-side flag on `vllm bench serve`, so its whole
concurrency sweep runs against one server — 3 starts per combo. That is
inherent to the two runtimes, not a scheduling mistake; don't try to
"optimise" it by editing the runner.

### If it stops partway through

Re-run `./run-all.sh --resume` (same `models.json`, same everything else).
It rebuilds the same `results/<card>-<model>.jsonl` paths deterministically
from the card and model name, and `--resume` skips cells already recorded in
each, including their model load, which is most of the cost. Do not rename or
move a results file to "start fresh" — that produces duplicate rows for the
cells that did complete, and breaks `run-all.sh`'s ability to find it again.

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

`run-all.sh` does most of this for you at the end of the run: a per-file
summary (row count, crashed count, tok/s range per card/backend/runtime) via
`lib/summarize-results.js`, followed by every results file already wrapped
like this so it can be extracted mechanically:

```
===BEGIN RESULTS FILE: results/b70-qwen3.8-27b.jsonl===
<full file contents, one JSON object per line>
===END RESULTS FILE===
```

Paste that whole block back verbatim — don't retype or reformat it. On top of it, add:

- A short plain-English summary in your own words: which cells ran clean,
  which came back `crashed=1` and why, anything that surprised you, and
  anything `run-all.sh` flagged as a non-zero exit needing a look.
- The preflight output from earlier, so the versions the rows claim can be
  checked against what was actually installed.

If you ran something outside `run-all.sh` (a single re-run via
`run-matrix.sh`/`run-llamacpp.sh`/`run-vllm.sh` directly), wrap that file's
contents the same way by hand.

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
