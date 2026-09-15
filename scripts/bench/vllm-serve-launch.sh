#!/bin/bash
# Launches `vllm serve` for one benchmark cell, using a named recipe from
# ../../recipes as the source of every tuning flag. Same arrangement as
# llama-server-launch.sh — see the reasoning there.
#
# Overrides only what the test matrix sweeps:
#   VLLM_MAX_MODEL_LEN  — the swept context axis
#   VLLM_PORT / VLLM_MODEL — per-run plumbing
#
# vLLM's sampling is per-request (set by `vllm bench serve`), not a serve-time
# flag, so there is no sampling override to make here.
#
# Invoked by run-vllm.sh with:
#   BENCH_RECIPE=<recipe-name> VLLM_MODEL=<path-or-id> VLLM_PORT=<port> \
#     [VLLM_MAX_MODEL_LEN=<n>] ./vllm-serve-launch.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

: "${BENCH_RECIPE:?BENCH_RECIPE is required — a name from recipes/, e.g. vllm-sycl-balanced}"
RECIPE_FILE="$REPO_ROOT/recipes/$BENCH_RECIPE.sh"
if [[ ! -f "$RECIPE_FILE" ]]; then
  echo "No such recipe: $RECIPE_FILE" >&2
  echo "Available:" >&2
  ls "$REPO_ROOT/recipes"/vllm-*.sh 2>/dev/null | xargs -n1 basename >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$RECIPE_FILE"

# Compatibility shim: the recipes were written against an older vLLM CLI that
# took `--device xpu` to select the platform. The installed vLLM (0.29.0,
# prebuilt XPU wheel — see HANDOFF-PLAN.md) auto-detects the platform via
# torch.xpu instead; `--device xpu` now fails hard
# (`ValueError: Non-integer device ID 'xpu' is not supported by xpu`) because
# newer vLLM repurposed --device for a numeric physical-device-id list. Strip
# it here rather than in the recipe files themselves, so the recipes stay the
# documented/published source of truth and this repair lives entirely in the
# runner. If a future vLLM version's --device semantics change again, this is
# the one place to revisit.
if [[ -n "${RECIPE_ARGS+x}" ]]; then
  FILTERED_ARGS=()
  skip_next=0
  for arg in "${RECIPE_ARGS[@]}"; do
    if [[ "$skip_next" == 1 ]]; then
      skip_next=0
      continue
    fi
    if [[ "$arg" == "--device" ]]; then
      skip_next=1
      continue
    fi
    FILTERED_ARGS+=("$arg")
  done
  RECIPE_ARGS=("${FILTERED_ARGS[@]}")
fi

recipe_launch
