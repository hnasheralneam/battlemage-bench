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

recipe_launch
