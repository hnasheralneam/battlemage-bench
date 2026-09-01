# Recipes

A small, hand-picked set of launch scripts for running a local model on an
Intel Arc B70 or B65 — three profiles per runtime and backend, and nothing
else. They are chosen rather than generated, and the reasoning is written into
each file.

These are also exactly what the benchmark runner launches. `scripts/bench/`
sources these files for every flag it does not itself sweep, overriding only
the swept axes (context, concurrency, prefill), the port and model, greedy
decoding, and `--metrics`. So the script you copy is the script that was
measured — a recipe cannot quietly drift away from the numbers offered as
evidence for it. Each published result records which recipe produced it.

Browse them with their measured results at `/recipes` on the site.

## The three profiles

| Profile | For | Costs |
|---|---|---|
| `performance` | One session, or a few. Interactive chat and coding where you are the only user. | A small context ceiling. |
| `balanced` | The one to run if you are not sure. Real context, a few parallel slots, headroom left. | Slower single-stream than `performance`, less context than `context`. |
| `context` | Long documents, whole-repository questions, RAG over big retrievals. | The slowest decode, and heavier KV quantisation. |

## The nine files

|  | llama.cpp / Vulkan | llama.cpp / SYCL | vLLM / SYCL |
|---|---|---|---|
| performance | `llamacpp-vulkan-performance.sh` | `llamacpp-sycl-performance.sh` | `vllm-sycl-performance.sh` |
| balanced | `llamacpp-vulkan-balanced.sh` | `llamacpp-sycl-balanced.sh` | `vllm-sycl-balanced.sh` |
| context | `llamacpp-vulkan-context.sh` | `llamacpp-sycl-context.sh` | `vllm-sycl-context.sh` |

There is no `vllm-vulkan-*`: vLLM has no Vulkan backend on Intel GPUs. That
combination does not exist, rather than being untested.

## Running one

```bash
LLAMA_MODEL_PATH=/path/to/model.gguf ./llamacpp-sycl-balanced.sh
VLLM_MODEL=/path-or-hf-id           ./vllm-sycl-balanced.sh
```

Each file has one or two `EDIT ME` paths pointing at your own llama.cpp
checkouts or vLLM environment — see [`../docs/SETUP.md`](../docs/SETUP.md).
Anything else you might want to change from the outside is an environment
variable with a default: `LLAMA_PORT`, `LLAMA_CTX_SIZE`, `LLAMA_PARALLEL`,
`LLAMA_SAMPLING_ARGS`, `LLAMA_EXTRA_ARGS`, and the `VLLM_*` equivalents.

## How they are structured

`lib/llamacpp-common.sh` and `lib/vllm-common.sh` hold only the plumbing —
locating the binary, sourcing oneAPI, pinning the GPU. Every flag that defines
a recipe stays written out in the recipe file itself, unabbreviated, so that
reading one tells you what it does without chasing an include.

Each file also declares its own metadata (`RECIPE_NAME`, `RECIPE_BACKEND`,
`RECIPE_KV_CACHE_TYPE`, ...) near the top. The site parses those to build the
recipe pages, and the benchmark runner reads `RECIPE_KV_CACHE_TYPE` onto every
row it emits. A recipe launches only when executed directly; sourcing one
defines `RECIPE_ARGS` and the metadata without starting anything.

## Changing one

Editing a recipe invalidates the results attached to it — the rows say they
were measured with that file, and they no longer were. If you want a different
configuration for yourself, copy the file and give it a new name. If you think
a recipe's defaults are wrong, that is worth submitting a result that shows it.
