#!/bin/bash
# llama.cpp / Vulkan — "performance" recipe
#
# Maximum throughput for one session, or a few.
#
# For: interactive chat and coding assistance where you are the only user and
#      you care about how fast tokens appear.
# Costs: a 16K context ceiling. Long documents and large repo dumps will not
#        fit — use the -context recipe for those.
#
# Backend: Vulkan. Generally the less finicky path to a working setup, and
# often close behind SYCL on throughput. No oneAPI dependency at runtime.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=llamacpp-vulkan-performance
#
# Usage:
#   LLAMA_MODEL_PATH=/path/to/model.gguf ./llamacpp-vulkan-performance.sh
#
# Override any of LLAMA_MODEL_PATH, LLAMA_MODEL_ALIAS, LLAMA_PORT,
# LLAMA_CTX_SIZE, LLAMA_PARALLEL, LLAMA_EXTRA_ARGS from the environment.
# Everything else is written out below — edit it here if you are tuning.

RECIPE_NAME="llamacpp-vulkan-performance"
RECIPE_RUNTIME="llama.cpp"
RECIPE_BACKEND="Vulkan"
RECIPE_PROFILE="performance"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="q8_0/q8_0 unified"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/llamacpp-common.sh"

# The context budget and the number of parallel slots are what separate the
# three profiles. -kvu makes --ctx-size one shared pool rather than a total
# carved into fixed per-slot shares, so adding slots does not shrink each
# session's ceiling.
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-16384}"
LLAMA_PARALLEL="${LLAMA_PARALLEL:-1}"

# KV cache is kept at q8_0 for both keys and values: at a 16K ceiling there is
# VRAM to spare, so there is no reason to trade quality for room here.

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
  --batch-size 8192
  --ubatch-size 2048
  --flash-attn on
  -ctk q8_0 -ctv q8_0
  -ngl 999                      # every layer on the GPU
  --cache-ram 16384
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
