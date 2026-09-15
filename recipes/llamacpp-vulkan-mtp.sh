#!/bin/bash
# llama.cpp / Vulkan — "mtp" recipe
#
# The -balanced recipe plus speculative decoding via a draft model's MTP
# (multi-token-prediction) head. Same context/parallelism/KV settings as
# -balanced — the only difference this recipe measures is MTP on vs. off.
#
# For: single-request / low-concurrency serving. Measured ~1.9x generation
#      throughput at concurrency=1 on this card (Qwen3.8-27B) — a real win,
#      not noise.
# Costs: needs a separate draft GGUF file (llama.cpp's MTP support for this
#        model family is not a single-file feature) — not every model has
#        one published. See LLAMA_DRAFT_MODEL_PATH below.
#        MORE IMPORTANTLY: the benefit collapses as concurrency rises. On
#        this card, measured throughput went net-NEGATIVE by concurrency=4
#        (0.33x — three times SLOWER with MTP on) and two of six cells at
#        concurrency=2/4 with long prompts crashed outright. llama.cpp's
#        parallel-slot batching appears to compete with the draft model for
#        the same batch slots, unlike vLLM's scheduler (see the vllm-sycl-mtp
#        recipe, which holds up much better under concurrency). Turn this on
#        for single-user/interactive local serving; leave it off for
#        multi-request serving on Vulkan/llama.cpp.
#
# Backend: Vulkan. (No SYCL/llama.cpp MTP recipe: the SYCL build's own
# unrelated server-startup crash on this box already rules out the SYCL/
# llama.cpp leg for every recipe — see HANDOFF-PLAN.md's "Hermes-gateway"
# notes. Nothing about that is MTP-specific, it's just never reachable.)
#
# Measured results from this recipe:
#   https://battlemage-benchmarks/results?recipe=llamacpp-vulkan-mtp
#
# Usage:
#   LLAMA_MODEL_PATH=/path/to/model.gguf \
#   LLAMA_DRAFT_MODEL_PATH=/path/to/draft.gguf \
#     ./llamacpp-vulkan-mtp.sh
#
# Override any of LLAMA_MODEL_PATH, LLAMA_MODEL_ALIAS, LLAMA_PORT,
# LLAMA_CTX_SIZE, LLAMA_PARALLEL, LLAMA_DRAFT_MODEL_PATH,
# LLAMA_SPEC_DRAFT_N_MAX, LLAMA_EXTRA_ARGS from the environment. Everything
# else is written out below — edit it here if you are tuning.

RECIPE_NAME="llamacpp-vulkan-mtp"
RECIPE_RUNTIME="llama.cpp"
RECIPE_BACKEND="Vulkan"
RECIPE_PROFILE="mtp"
# Recorded on every benchmark row this recipe produces, so a published number
# says which KV precision it was measured at.
RECIPE_KV_CACHE_TYPE="q8_0/q4_1 unified"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/llamacpp-common.sh"

# Same context/parallelism as -balanced — this recipe isolates the MTP
# variable rather than also varying the workload it's measured against.
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-65536}"
LLAMA_PARALLEL="${LLAMA_PARALLEL:-4}"

# The draft model: a separate, smaller GGUF whose predictions the main model
# either accepts or rejects token-by-token. Required — there is no default
# that means anything across different base models.
: "${LLAMA_DRAFT_MODEL_PATH:?LLAMA_DRAFT_MODEL_PATH is required -- path to the draft .gguf, e.g. the MTP/mtp-<model>-Q4_0.gguf file from an unsloth <model>-GGUF repo}"

# Draft depth: how many tokens ahead the draft model guesses before the main
# model checks them in one batched forward pass. llama.cpp's own default is
# 3; upstream docs suggest starting lower (~2) and tuning from there, since a
# deeper draft costs more when it's wrong.
LLAMA_SPEC_DRAFT_N_MAX="${LLAMA_SPEC_DRAFT_N_MAX:-2}"

# Sampling. These are what the recipe recommends for real use. The benchmark
# runner replaces them wholesale with greedy decoding (LLAMA_SAMPLING_ARGS=
# "--temp 0") so its numbers aren't shifted by the sampler — set as one
# variable rather than appended, so there is never a duplicated --temp whose
# precedence you have to reason about.
LLAMA_SAMPLING_ARGS="${LLAMA_SAMPLING_ARGS:---temp 0.6 --top-k 20 --top-p 0.95 --min-p 0}"
# Intentionally unquoted: a flag string that has to word-split into args.
# shellcheck disable=SC2206
RECIPE_SAMPLING=( ${LLAMA_SAMPLING_ARGS} )

RECIPE_ARGS=(
  -m "$LLAMA_MODEL_PATH"
  -a "$LLAMA_MODEL_ALIAS"
  --ctx-size "$LLAMA_CTX_SIZE"
  -kvu                          # unified KV cache: one shared budget
  --parallel "$LLAMA_PARALLEL"
  --cont-batching
  --split-mode none
  --batch-size 4096
  --ubatch-size 1024
  --flash-attn on
  -ctk q8_0 -ctv q4_1
  -ngl 999                      # every layer on the GPU
  --cache-ram 14336
  --fit off
  --load-mode none
  --jinja
  --spec-type draft-mtp
  -md "$LLAMA_DRAFT_MODEL_PATH"
  --spec-draft-n-max "$LLAMA_SPEC_DRAFT_N_MAX"
  "${RECIPE_SAMPLING[@]}"
  --host "$LLAMA_HOST"
  --port "$LLAMA_PORT"
)

# Sourced (by the benchmark runner, which wants RECIPE_ARGS and the metadata
# above but supplies its own launch): stop here. Executed directly: launch.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  recipe_launch
fi
