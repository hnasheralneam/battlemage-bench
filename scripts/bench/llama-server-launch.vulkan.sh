#!/bin/bash
# llama-server launch for the Vulkan backend. Same shape as
# llama-server-launch.sycl.sh, minus the oneAPI/Level-Zero plumbing that's
# SYCL-specific, and pointed at a separate llama.cpp checkout built with the
# Vulkan backend.
#
# Invoked by run-llamacpp.sh with:
#   LLAMA_PARALLEL=<N> LLAMA_PORT=<port> LLAMA_MODEL_PATH=<path> \
#     LLAMA_MODEL_ALIAS=<alias> [LLAMA_CTX_SIZE=<n>] ./llama-server-launch.vulkan.sh

set -euo pipefail

# --- EDIT ME: path to your Vulkan-built llama.cpp checkout ---
LLAMACPP_VULKAN_DIR="${LLAMACPP_VULKAN_DIR:-$HOME/llama.cpp-vulkan}"
LLAMA_BIN="$LLAMACPP_VULKAN_DIR/build/bin/llama-server"

export CUDA_VISIBLE_DEVICES=""

# If more than one Vulkan-capable device is visible (e.g. both cards
# installed at once), select which one llama.cpp uses here — e.g. via
# GGML_VK_VISIBLE_DEVICES=<index>. Left unset by default (single card
# assumed active); uncomment and adjust if you run multi-GPU.
# export GGML_VK_VISIBLE_DEVICES="0"

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
