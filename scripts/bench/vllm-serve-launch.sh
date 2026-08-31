#!/bin/bash
# vLLM server launch for the SYCL/XPU backend (vLLM has no Vulkan backend on
# Intel GPUs, so there's only one variant of this file, unlike the two
# llama-server-launch.*.sh files).
#
# --- EDIT ME ---
# This is a placeholder based on vLLM's documented XPU invocation shape, not
# a real tuned command like the llama.cpp launch scripts — fill in your
# actual environment activation, model, and flags before running it for
# real. In particular:
#   - VLLM_ENV_ACTIVATE below assumes a venv; swap for conda/uv/etc. as needed
#   - VLLM_EXTRA_ARGS is where any tuning flags (max-num-seqs, gpu-memory-
#     utilization, dtype/quantization, block-size, etc.) should go
#
# Invoked by run-vllm.sh with:
#   VLLM_MODEL=<path-or-hf-id> VLLM_PORT=<port> [VLLM_MAX_MODEL_LEN=<n>] \
#     ./vllm-serve-launch.sh
#
# Uses `exec` so the resulting vllm serve process takes over this script's
# PID directly — the caller can kill that one PID cleanly.

set -euo pipefail

# --- EDIT ME: path to the Python env with vLLM's XPU build installed ---
VLLM_ENV_ACTIVATE="${VLLM_ENV_ACTIVATE:-$HOME/vllm-xpu/bin/activate}"
if [[ -f "$VLLM_ENV_ACTIVATE" ]]; then
  source "$VLLM_ENV_ACTIVATE"
fi

export CUDA_VISIBLE_DEVICES=""
export ONEAPI_DEVICE_SELECTOR="level_zero:gpu"

: "${VLLM_MODEL:?VLLM_MODEL is required}"
: "${VLLM_PORT:?VLLM_PORT is required}"
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"

# --- EDIT ME: any additional tuning flags, held constant across the sweep ---
VLLM_EXTRA_ARGS="${VLLM_EXTRA_ARGS:-}"

exec vllm serve "$VLLM_MODEL" \
  --device xpu \
  --port "$VLLM_PORT" \
  --host 0.0.0.0 \
  --max-model-len "$VLLM_MAX_MODEL_LEN" \
  $VLLM_EXTRA_ARGS
