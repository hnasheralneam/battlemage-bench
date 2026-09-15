#!/bin/bash
# vLLM / SYCL — "mtp" recipe
#
# The -balanced recipe plus speculative decoding via the checkpoint's own
# bundled MTP (multi-token-prediction) head. Same context/batching settings
# as -balanced — the only difference this recipe measures is MTP on vs. off.
#
# For: broadly worth turning on. Unlike the llama.cpp side, no separate
#      draft file is needed here — Qwen3.8-27B and Qwen3.6-35B-A3B's
#      published checkpoints both already carry MTP weights (confirmed via
#      config.json's mtp_num_hidden_layers and mtp.* parameter names — see
#      HANDOFF-PLAN.md's MTP research notes). Measured 1.0x-1.9x generation
#      throughput on this card across concurrency 1-8 — a consistent win at
#      low concurrency (up to ~1.5x) that mostly holds up even under load,
#      unlike the llama.cpp/Vulkan MTP recipe which turns net-negative by
#      concurrency=4. The one soft spot: Qwen3.8-27B's heaviest cell
#      (concurrency=8, long prompts) measured 0.61x — a real loss, not
#      noise — so don't assume the win holds at max concurrency for every
#      model; the MoE model (Qwen3.6-35B-A3B) held up noticeably better
#      under load than the dense one in this measurement.
# Costs: draft-model overhead per step; whether that's a net win depends on
#        how often the draft's guess is accepted, which varies by workload.
#
# Backend: SYCL/XPU. vLLM has no Vulkan backend on Intel GPUs, so unlike the
# llama.cpp recipes there is only one backend variant of this profile too.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=vllm-sycl-mtp
#
# Usage:
#   VLLM_MODEL=/path-or-hf-id ./vllm-sycl-mtp.sh
#
# Override any of VLLM_MODEL, VLLM_PORT, VLLM_MAX_MODEL_LEN,
# VLLM_SPEC_NUM_TOKENS, VLLM_EXTRA_ARGS from the environment. Everything else
# is written out below.

RECIPE_NAME="vllm-sycl-mtp"
RECIPE_RUNTIME="vLLM"
RECIPE_BACKEND="SYCL"
RECIPE_PROFILE="mtp"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="fp8 paged"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/vllm-common.sh"

# Same context/batching as -balanced — this recipe isolates the MTP variable
# rather than also varying the workload it's measured against.
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-65536}"
VLLM_MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-16}"

# How many tokens ahead the MTP head drafts before the base model verifies
# them in one batched step. vLLM's own docs recommend starting at 1 and
# tuning up; a deeper draft costs more when it's rejected.
VLLM_SPEC_NUM_TOKENS="${VLLM_SPEC_NUM_TOKENS:-1}"

# fp8 KV cache. At 16 slots and a 64K ceiling the KV cache is what runs the
# card out of memory first, and fp8 roughly halves it for little measurable
# quality cost on these models.

RECIPE_ARGS=(
  --max-model-len "$VLLM_MAX_MODEL_LEN"
  --max-num-seqs "$VLLM_MAX_NUM_SEQS"
  --gpu-memory-utilization 0.90
  --kv-cache-dtype fp8
  --speculative-config "{\"method\":\"mtp\",\"num_speculative_tokens\":$VLLM_SPEC_NUM_TOKENS}"
  --host "$VLLM_HOST"
  --port "$VLLM_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
