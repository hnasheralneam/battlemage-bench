#!/bin/bash
# llama.cpp / SYCL — "context" recipe
#
# Maximum usable context on a 32 GB card.
#
# For: long documents, whole-repository questions, RAG over big retrievals.
# Costs: the slowest of the three, and single-session only. A 256K KV budget
#        is most of what the card has left after the weights.
#
# Backend: SYCL (Intel oneAPI / Level Zero). Usually the faster of the two
# when it builds cleanly, and the fussier one to get building. Needs the
# oneAPI environment sourced — recipes/lib/llamacpp-common.sh does that.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=llamacpp-sycl-context
#
# Usage:
#   LLAMA_MODEL_PATH=/path/to/model.gguf ./llamacpp-sycl-context.sh
#
# Override any of LLAMA_MODEL_PATH, LLAMA_MODEL_ALIAS, LLAMA_PORT,
# LLAMA_CTX_SIZE, LLAMA_PARALLEL, LLAMA_EXTRA_ARGS from the environment.
# Everything else is written out below — edit it here if you are tuning.

RECIPE_NAME="llamacpp-sycl-context"
RECIPE_RUNTIME="llama.cpp"
RECIPE_BACKEND="SYCL"
RECIPE_PROFILE="context"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="q4_0/q4_0 unified"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/llamacpp-common.sh"

# The context budget and the number of parallel slots are what separate the
# three profiles. -kvu makes --ctx-size one shared pool rather than a total
# carved into fixed per-slot shares, so adding slots does not shrink each
# session's ceiling.
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-262144}"
LLAMA_PARALLEL="${LLAMA_PARALLEL:-1}"

# Both keys and values at q4_0. This is the trade the profile exists to make:
# at 256K the KV cache is the dominant VRAM consumer, and nothing else frees
# up as much. Expect some quality cost on long-range recall.

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
  --batch-size 2048
  --ubatch-size 512
  --flash-attn on
  -ctk q4_0 -ctv q4_0
  -ngl 999                      # every layer on the GPU
  --cache-ram 8192
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
