#!/bin/bash
# vLLM / SYCL — "balanced" recipe
#
# The everyday default. Real context, real batching.
#
# For: serving a small team or a household, or an agent loop that keeps
#      several requests in flight. The profile to pick if unsure.
# Costs: slower single-stream than -performance, smaller context than -context.
#
# Backend: SYCL/XPU. vLLM has no Vulkan backend on Intel GPUs, so unlike the
# llama.cpp recipes there is only one backend variant of each vLLM profile.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=vllm-sycl-balanced
#
# Usage:
#   VLLM_MODEL=/path-or-hf-id ./vllm-sycl-balanced.sh
#
# Override any of VLLM_MODEL, VLLM_PORT, VLLM_MAX_MODEL_LEN, VLLM_EXTRA_ARGS
# from the environment. Everything else is written out below.

RECIPE_NAME="vllm-sycl-balanced"
RECIPE_RUNTIME="vLLM"
RECIPE_BACKEND="SYCL"
RECIPE_PROFILE="balanced"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="fp8 paged"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/vllm-common.sh"

# --max-model-len is a per-request ceiling that concurrency does not divide,
# which is the main way vLLM's context flag differs from llama.cpp's.
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-65536}"
VLLM_MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-16}"

# fp8 KV cache. At 16 slots and a 64K ceiling the KV cache is what runs the
# card out of memory first, and fp8 roughly halves it for little measurable
# quality cost on these models.

RECIPE_ARGS=(
  --device xpu
  --max-model-len "$VLLM_MAX_MODEL_LEN"
  --max-num-seqs "$VLLM_MAX_NUM_SEQS"
  --gpu-memory-utilization 0.90
  --kv-cache-dtype fp8
  --host "$VLLM_HOST"
  --port "$VLLM_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
