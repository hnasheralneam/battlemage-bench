#!/bin/bash
# vLLM / SYCL — "context" recipe
#
# Maximum usable context on a 32 GB card.
#
# For: long documents, whole-repository questions, RAG over big retrievals.
# Costs: few concurrent slots and the slowest decode of the three. A 256K
#        ceiling is most of what the card has left after the weights.
#
# Backend: SYCL/XPU. vLLM has no Vulkan backend on Intel GPUs, so unlike the
# llama.cpp recipes there is only one backend variant of each vLLM profile.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=vllm-sycl-context
#
# Usage:
#   VLLM_MODEL=/path-or-hf-id ./vllm-sycl-context.sh
#
# Override any of VLLM_MODEL, VLLM_PORT, VLLM_MAX_MODEL_LEN, VLLM_EXTRA_ARGS
# from the environment. Everything else is written out below.

RECIPE_NAME="vllm-sycl-context"
RECIPE_RUNTIME="vLLM"
RECIPE_BACKEND="SYCL"
RECIPE_PROFILE="context"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="fp8 paged"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/vllm-common.sh"

# --max-model-len is a per-request ceiling that concurrency does not divide,
# which is the main way vLLM's context flag differs from llama.cpp's.
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-262144}"
VLLM_MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-4}"

# fp8 KV cache and a raised memory-utilisation ceiling. Both are needed to
# reach 256K at all; expect this profile to be the most likely of the three to
# OOM if the model or quant is larger than the ones benchmarked here.

RECIPE_ARGS=(
  --device xpu
  --max-model-len "$VLLM_MAX_MODEL_LEN"
  --max-num-seqs "$VLLM_MAX_NUM_SEQS"
  --gpu-memory-utilization 0.95
  --kv-cache-dtype fp8
  --enable-chunked-prefill
  --host "$VLLM_HOST"
  --port "$VLLM_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
