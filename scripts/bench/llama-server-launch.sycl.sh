#!/bin/bash
# llama-server launch for the SYCL backend. Based on the user's real tuned
# launch command — everything except LLAMA_PARALLEL/LLAMA_PORT/model
# selection is a literal flag here, edited directly in this file rather than
# threaded through as CLI options, since it's tuned per-hardware and isn't
# itself part of what the test matrix sweeps.
#
# Invoked by run-llamacpp.sh with:
#   LLAMA_PARALLEL=<N> LLAMA_PORT=<port> LLAMA_MODEL_PATH=<path> \
#     LLAMA_MODEL_ALIAS=<alias> [LLAMA_CTX_SIZE=<n>] ./llama-server-launch.sycl.sh
#
# Uses `exec` so the resulting llama-server process takes over this script's
# PID directly — the caller can kill that one PID cleanly.

set -euo pipefail

# --- EDIT ME: path to your SYCL-built llama.cpp checkout ---
LLAMACPP_SYCL_DIR="${LLAMACPP_SYCL_DIR:-$HOME/llama.cpp-sycl}"
LLAMA_BIN="$LLAMACPP_SYCL_DIR/build/bin/llama-server"

if [[ -f /opt/intel/oneapi/setvars.sh ]]; then
  source /opt/intel/oneapi/setvars.sh > /dev/null 2>&1
elif [[ -f ~/intel/oneapi/setvars.sh ]]; then
  source ~/intel/oneapi/setvars.sh > /dev/null 2>&1
fi

export CUDA_VISIBLE_DEVICES=""
export ONEAPI_DEVICE_SELECTOR="level_zero:gpu"

: "${LLAMA_MODEL_PATH:?LLAMA_MODEL_PATH is required}"
: "${LLAMA_MODEL_ALIAS:?LLAMA_MODEL_ALIAS is required}"
: "${LLAMA_PARALLEL:?LLAMA_PARALLEL is required}"
: "${LLAMA_PORT:?LLAMA_PORT is required}"
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-221760}"

exec "$LLAMA_BIN" \
  -m "$LLAMA_MODEL_PATH" \
  -a "$LLAMA_MODEL_ALIAS" \
  --ctx-size "$LLAMA_CTX_SIZE" \
  -kvu \
  --split-mode none \
  --parallel "$LLAMA_PARALLEL" \
  --cont-batching \
  --batch-size 8192 \
  --ubatch-size 2048 \
  --flash-attn on \
  -ctk q8_0 -ctv q4_1 \
  --jinja \
  --temp 0.6 --top-k 20 --top-p 0.95 --min-p 0 \
  --host 0.0.0.0 --port "$LLAMA_PORT" \
  --cache-ram 14384 \
  --fit off \
  --load-mode none \
  -ngl 999 \
  --metrics
