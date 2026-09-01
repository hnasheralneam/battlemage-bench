#!/bin/bash
# vLLM / SYCL — "performance" recipe
#
# Maximum throughput for one session, or a few.
#
# For: interactive use where you are the only user, or nearly. vLLM is built
#      for batched serving, so this profile is the one that competes with
#      llama.cpp on its own ground rather than vLLM's.
# Costs: a 16K context ceiling, and few concurrent slots.
#
# Backend: SYCL/XPU. vLLM has no Vulkan backend on Intel GPUs, so unlike the
# llama.cpp recipes there is only one backend variant of each vLLM profile.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=vllm-sycl-performance
#
# Usage:
#   VLLM_MODEL=/path-or-hf-id ./vllm-sycl-performance.sh
#
# Override any of VLLM_MODEL, VLLM_PORT, VLLM_MAX_MODEL_LEN, VLLM_EXTRA_ARGS
# from the environment. Everything else is written out below.

RECIPE_NAME="vllm-sycl-performance"
RECIPE_RUNTIME="vLLM"
RECIPE_BACKEND="SYCL"
RECIPE_PROFILE="performance"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="fp16 paged"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/vllm-common.sh"

# --max-model-len is a per-request ceiling that concurrency does not divide,
# which is the main way vLLM's context flag differs from llama.cpp's.
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-16384}"
VLLM_MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-8}"

# KV cache left at the model's own dtype. At a 16K ceiling with 8 slots there
# is room for it, and it is the only setting here with no quality cost.

RECIPE_ARGS=(
  --device xpu
  --max-model-len "$VLLM_MAX_MODEL_LEN"
  --max-num-seqs "$VLLM_MAX_NUM_SEQS"
  --gpu-memory-utilization 0.90
  --kv-cache-dtype auto
  --host "$VLLM_HOST"
  --port "$VLLM_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
