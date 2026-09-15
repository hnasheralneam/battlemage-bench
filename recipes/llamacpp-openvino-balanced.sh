#!/bin/bash
# llama.cpp / OpenVINO — "balanced" recipe
#
# Experimental. OpenVINO's native ggml backend (GGML_OPENVINO=ON) is a
# preview-stage integration, not this site's recommended path for daily use
# — Vulkan and SYCL are both faster and more mature on this hardware as of
# this recipe's last measurement. This recipe exists so the site can publish
# real numbers for it rather than silently skipping the third backend
# llama.cpp actually supports on Intel GPUs.
#
# For: curiosity, or hardware where Vulkan/SYCL genuinely don't work.
# Costs: slower generation than Vulkan/SYCL (measured ~4x on this hardware),
#        and a much more RAM-hungry graph-compile step at model load —
#        see docs/SETUP.md's OpenVINO section before running this on a
#        model much bigger than what you've already tested.
#
# Backend: OpenVINO GPU plugin. Needs the OpenVINO runtime's environment
# sourced — recipes/lib/llamacpp-common.sh does that, and also sets the
# memory-reduction env vars (GGML_OPENVINO_MEMORY_OPTIMIZE and friends,
# including GGML_OPENVINO_SPILL_DIR) that are what make a model of any real
# size compile successfully at all on constrained-RAM hardware.
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=llamacpp-openvino-balanced
#
# Usage:
#   LLAMA_MODEL_PATH=/path/to/model.gguf ./llamacpp-openvino-balanced.sh
#
# Override any of LLAMA_MODEL_PATH, LLAMA_MODEL_ALIAS, LLAMA_PORT,
# LLAMA_CTX_SIZE, LLAMA_PARALLEL, LLAMA_EXTRA_ARGS from the environment.
# Everything else is written out below — edit it here if you are tuning.

RECIPE_NAME="llamacpp-openvino-balanced"
RECIPE_RUNTIME="llama.cpp"
RECIPE_BACKEND="OpenVINO"
RECIPE_PROFILE="balanced"
# The OpenVINO backend does not honor llama.cpp's own -ctk/-ctv KV
# quantization flags the way Vulkan/SYCL do — KV precision here is whatever
# the backend's own graph uses internally, not a dial this recipe turns.
RECIPE_KV_CACHE_TYPE="backend-managed (not user-selectable)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/llamacpp-common.sh"

LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-8192}"
LLAMA_PARALLEL="${LLAMA_PARALLEL:-1}"

# Sampling — see llamacpp-vulkan-balanced.sh's comment; same reasoning here.
LLAMA_SAMPLING_ARGS="${LLAMA_SAMPLING_ARGS:---temp 0.6 --top-k 20 --top-p 0.95 --min-p 0}"
# shellcheck disable=SC2206
RECIPE_SAMPLING=( ${LLAMA_SAMPLING_ARGS} )

# Deliberately minimal compared to the Vulkan/SYCL recipes: this backend is
# a preview integration, and every flag here is one that was actually
# confirmed working in real testing (docs/SETUP.md, HANDOFF-PLAN.md) rather
# than assumed to carry over from the other two backends. In particular, no
# -kvu/-ctk/-ctv/--cache-ram/--split-mode/--flash-attn — none of those were
# verified against this backend, and it is not this recipe's job to guess.
RECIPE_ARGS=(
  -m "$LLAMA_MODEL_PATH"
  -a "$LLAMA_MODEL_ALIAS"
  --ctx-size "$LLAMA_CTX_SIZE"
  --parallel "$LLAMA_PARALLEL"
  --cont-batching
  -ngl 999                      # every layer on the GPU
  --jinja
  "${RECIPE_SAMPLING[@]}"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
