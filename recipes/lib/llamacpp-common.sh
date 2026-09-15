#!/bin/bash
# Shared environment setup for the llama.cpp recipes. Only the plumbing lives
# here — locating the binary, sourcing oneAPI, picking the GPU. Every flag that
# defines a recipe stays written out in the recipe file itself, so the script
# you copy off the site is the script that ran.
#
# Sourced by recipes/llamacpp-*.sh, which set RECIPE_BACKEND first.

set -euo pipefail

: "${RECIPE_BACKEND:?RECIPE_BACKEND must be set before sourcing this file}"

case "$RECIPE_BACKEND" in
  SYCL)
    # --- EDIT ME: your SYCL-built llama.cpp checkout ---
    LLAMACPP_DIR="${LLAMACPP_SYCL_DIR:-$HOME/llama.cpp-sycl}"
    # THE actual root cause of the historical "SYCL/llama.cpp mass crashes,
    # instant death, empty log, no error" pattern (blamed on Hermes/GPU
    # contention throughout HANDOFF-PLAN.md -- it was never that): oneAPI's
    # own setvars.sh is SOURCED (runs in this shell, not a subshell) and, a
    # few layers down, references two variables it does not itself default
    # -- `OCL_ICD_FILENAMES` (compiler/latest/env/vars.sh) and `TCM_ROOT`
    # (umf/latest/env/vars.sh) -- assuming the CALLER already exported them.
    # This file runs under `set -u` (line 9); an unset variable reference
    # anywhere in a sourced script is an immediate hard error in the CURRENT
    # shell, unconditionally (nounset, unlike errexit, cannot be worked
    # around with `set +e` or a trailing `|| true` on the source line --
    # confirmed by testing both). Whenever the launching shell hadn't
    # already exported both of these first, sourcing setvars.sh here died
    # instantly and silently (output redirected to /dev/null) partway
    # through, before reaching anything that would print an error -- which
    # is exactly the "empty log, no error" signature. Defaulting them here,
    # not just documenting them as something the operator's shell has to
    # remember to export, is what actually fixes it for good. See
    # docs/SETUP.md's SYCL troubleshooting section and HANDOFF-PLAN.md.
    export OCL_ICD_FILENAMES="${OCL_ICD_FILENAMES:-}"
    export TCM_ROOT="${TCM_ROOT:-}"
    if [[ -f /opt/intel/oneapi/setvars.sh ]]; then
      source /opt/intel/oneapi/setvars.sh > /dev/null 2>&1
    elif [[ -f ~/intel/oneapi/setvars.sh ]]; then
      source ~/intel/oneapi/setvars.sh > /dev/null 2>&1
    fi
    # Level Zero tuning that a day-to-day SYCL deployment on this hardware
    # found necessary for reliable operation (see docs/SETUP.md's SYCL
    # troubleshooting section for the story). Defaulted here, not just left
    # to the operator's shell, so a fresh checkout of this repo gets the same
    # stability out of the box that the daily-driver setup already has.
    export SYCL_PI_LEVEL_ZERO_USE_IMMEDIATE_COMMANDLISTS="${SYCL_PI_LEVEL_ZERO_USE_IMMEDIATE_COMMANDLISTS:-0}"
    export SYCL_CACHE_PERSISTENT="${SYCL_CACHE_PERSISTENT:-0}"
    export SYCL_DEVICE_FILTER="${SYCL_DEVICE_FILTER:-level_zero}"
    export ZE_FLAT_DEVICE_HIERARCHY="${ZE_FLAT_DEVICE_HIERARCHY:-COMPOSITE}"
    export ZE_AFFINITY_MASK="${ZE_AFFINITY_MASK:-0}"
    ;;
  Vulkan)
    # --- EDIT ME: your Vulkan-built llama.cpp checkout ---
    LLAMACPP_DIR="${LLAMACPP_VULKAN_DIR:-$HOME/llama.cpp-vulkan}"
    ;;
  *)
    echo "RECIPE_BACKEND must be SYCL or Vulkan, got: $RECIPE_BACKEND" >&2
    exit 1
    ;;
esac

LLAMA_BIN="${LLAMA_BIN:-$LLAMACPP_DIR/build/bin/llama-server}"
if [[ ! -x "$LLAMA_BIN" ]]; then
  echo "llama-server not found or not executable at: $LLAMA_BIN" >&2
  echo "Set LLAMACPP_${RECIPE_BACKEND^^}_DIR to your checkout, or LLAMA_BIN to the binary." >&2
  echo "See docs/SETUP.md for how to build both backends side by side." >&2
  exit 1
fi

# Keep any CUDA device out of the picture, and pin SYCL to the Level Zero GPU
# rather than letting it pick a CPU or OpenCL device.
export CUDA_VISIBLE_DEVICES=""
export ONEAPI_DEVICE_SELECTOR="${ONEAPI_DEVICE_SELECTOR:-level_zero:gpu}"

: "${LLAMA_MODEL_PATH:?LLAMA_MODEL_PATH is required — path to the .gguf}"
LLAMA_MODEL_ALIAS="${LLAMA_MODEL_ALIAS:-$(basename "$LLAMA_MODEL_PATH" .gguf)}"
LLAMA_HOST="${LLAMA_HOST:-0.0.0.0}"
LLAMA_PORT="${LLAMA_PORT:-8080}"

# Launches the server with the recipe's own flags, then anything in
# LLAMA_EXTRA_ARGS. The benchmark runner uses that tail to override sampling
# and turn on --metrics without editing (or diverging from) the recipe.
recipe_launch() {
  local extra=()
  if [[ -n "${LLAMA_EXTRA_ARGS:-}" ]]; then
    # Intentionally unquoted: LLAMA_EXTRA_ARGS is a flag string from the
    # operator or the bench runner, and has to word-split into separate args.
    # shellcheck disable=SC2206
    extra=( ${LLAMA_EXTRA_ARGS} )
  fi
  echo "Launching $RECIPE_NAME: $LLAMA_BIN ${RECIPE_ARGS[*]} ${extra[*]}" >&2
  exec "$LLAMA_BIN" "${RECIPE_ARGS[@]}" "${extra[@]}"
}
