#!/bin/bash
# Shared environment setup for the vLLM recipes (SYCL/XPU only — vLLM has no
# Vulkan backend on Intel GPUs). Only the plumbing lives here; the flags that
# define a recipe stay written out in the recipe file itself.
#
# Sourced by recipes/vllm-sycl-*.sh.

set -euo pipefail

# --- EDIT ME: the Python env with vLLM's XPU build installed ---
# See docs/SETUP.md — this is the piece most likely to need adjusting.
VLLM_ENV_ACTIVATE="${VLLM_ENV_ACTIVATE:-$HOME/vllm-xpu/bin/activate}"
if [[ -f "$VLLM_ENV_ACTIVATE" ]]; then
  # shellcheck disable=SC1090
  source "$VLLM_ENV_ACTIVATE"
fi

if ! command -v vllm > /dev/null 2>&1; then
  echo "vllm not found on PATH after activating: $VLLM_ENV_ACTIVATE" >&2
  echo "See docs/SETUP.md for installing the XPU build." >&2
  exit 1
fi

export CUDA_VISIBLE_DEVICES=""
export ONEAPI_DEVICE_SELECTOR="${ONEAPI_DEVICE_SELECTOR:-level_zero:gpu}"

: "${VLLM_MODEL:?VLLM_MODEL is required — HF id or local path}"
VLLM_HOST="${VLLM_HOST:-0.0.0.0}"
VLLM_PORT="${VLLM_PORT:-8000}"

recipe_launch() {
  local extra=()
  if [[ -n "${VLLM_EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    extra=( ${VLLM_EXTRA_ARGS} )
  fi
  echo "Launching $RECIPE_NAME: vllm serve ${RECIPE_ARGS[*]} ${extra[*]}" >&2
  exec vllm serve "$VLLM_MODEL" "${RECIPE_ARGS[@]}" "${extra[@]}"
}
