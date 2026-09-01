#!/bin/bash
# llama.cpp / SYCL — "balanced" recipe
#
# The everyday default. Real context, room for a few sessions.
#
# For: the setup to run if you are not sure which to run. Handles ordinary
#      documents, serves a small household or team, leaves headroom.
# Costs: slower than -performance single-stream, smaller context than -context.
#
# Backend: SYCL (Intel oneAPI / Level Zero). Usually the faster of the two
# when it builds cleanly, and the fussier one to get building. Needs the
# oneAPI environment sourced — recipes/lib/llamacpp-common.sh does that.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=llamacpp-sycl-balanced
#
# Usage:
#   LLAMA_MODEL_PATH=/path/to/model.gguf ./llamacpp-sycl-balanced.sh
#
# Override any of LLAMA_MODEL_PATH, LLAMA_MODEL_ALIAS, LLAMA_PORT,
# LLAMA_CTX_SIZE, LLAMA_PARALLEL, LLAMA_EXTRA_ARGS from the environment.
# Everything else is written out below — edit it here if you are tuning.

RECIPE_NAME="llamacpp-sycl-balanced"
RECIPE_RUNTIME="llama.cpp"
RECIPE_BACKEND="SYCL"
RECIPE_PROFILE="balanced"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="q8_0/q4_1 unified"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/llamacpp-common.sh"

# The context budget and the number of parallel slots are what separate the
# three profiles. -kvu makes --ctx-size one shared pool rather than a total
# carved into fixed per-slot shares, so adding slots does not shrink each
# session's ceiling.
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-65536}"
LLAMA_PARALLEL="${LLAMA_PARALLEL:-4}"

# Asymmetric KV quantisation: keys at q8_0, values at q4_1. Values tolerate
# heavier quantisation than keys do, so this buys most of the VRAM saving at
# a fraction of the quality cost of quantising both.

# Sampling. These are what the recipe recommends for real use. The benchmark
# runner replaces them wholesale with greedy decoding (LLAMA_SAMPLING_ARGS=
# "--temp 0") so its numbers aren't shifted by the sampler — set as one
# variable rather than appended, so there is never a duplicated --temp whose
# precedence you have to reason about.
LLAMA_SAMPLING_ARGS="${LLAMA_SAMPLING_ARGS:---temp 0.6 --top-k 20 --top-p 0.95 --min-p 0}"
# Intentionally unquoted: a flag string that has to word-split into args.
# shellcheck disable=SC2206
RECIPE_SAMPLING=( ${LLAMA_SAMPLING_ARGS} )

RECIPE_ARGS=(
  -m "$LLAMA_MODEL_PATH"
  -a "$LLAMA_MODEL_ALIAS"
  --ctx-size "$LLAMA_CTX_SIZE"
  -kvu                          # unified KV cache: one shared budget
  --parallel "$LLAMA_PARALLEL"
  --cont-batching
  --split-mode none
  --batch-size 4096
  --ubatch-size 1024
  --flash-attn on
  -ctk q8_0 -ctv q4_1
  -ngl 999                      # every layer on the GPU
  --cache-ram 14336
  --fit off
  --load-mode none
  --jinja
  "${RECIPE_SAMPLING[@]}"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
