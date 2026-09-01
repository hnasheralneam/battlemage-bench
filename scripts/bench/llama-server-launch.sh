#!/bin/bash
# Launches llama-server for one benchmark cell, using a named recipe from
# ../../recipes as the source of every tuning flag.
#
# The recipes are the flags this site recommends; measuring anything else
# would publish numbers for a configuration nobody is being told to run. So
# this is a thin wrapper rather than its own tuned command: it sources the
# recipe, overrides only what the test matrix sweeps, and launches.
#
# What it overrides, and why each one is not a recipe decision:
#   LLAMA_CTX_SIZE / LLAMA_PARALLEL  — the swept axes
#   LLAMA_PORT / LLAMA_MODEL_PATH    — per-run plumbing
#   LLAMA_SAMPLING_ARGS              — greedy, so run-to-run variance comes
#                                      from the hardware and not the sampler
#   --metrics                        — the throughput counters are read from it
#
# Invoked by run-llamacpp.sh with:
#   BENCH_RECIPE=<recipe-name> LLAMA_MODEL_PATH=<path> LLAMA_MODEL_ALIAS=<alias> \
#     LLAMA_PARALLEL=<n> LLAMA_PORT=<port> LLAMA_CTX_SIZE=<n> \
#     ./llama-server-launch.sh
#
# The recipe ends in `exec`, so the resulting llama-server takes over this
# script's PID and the caller can kill that one PID cleanly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

: "${BENCH_RECIPE:?BENCH_RECIPE is required — a name from recipes/, e.g. llamacpp-sycl-balanced}"
RECIPE_FILE="$REPO_ROOT/recipes/$BENCH_RECIPE.sh"
if [[ ! -f "$RECIPE_FILE" ]]; then
  echo "No such recipe: $RECIPE_FILE" >&2
  echo "Available:" >&2
  ls "$REPO_ROOT/recipes"/*.sh 2>/dev/null | xargs -n1 basename >&2
  exit 1
fi

# Greedy decoding for measurement. Set as the whole sampling string rather
# than appended, so there is no duplicated --temp to reason about.
export LLAMA_SAMPLING_ARGS="--temp 0"
export LLAMA_EXTRA_ARGS="--metrics ${LLAMA_EXTRA_ARGS:-}"

# Sourced, not executed, so the recipe defines RECIPE_ARGS and its metadata
# (RECIPE_KV_CACHE_TYPE, RECIPE_BACKEND, ...) without launching on its own.
# shellcheck disable=SC1090
source "$RECIPE_FILE"

recipe_launch
