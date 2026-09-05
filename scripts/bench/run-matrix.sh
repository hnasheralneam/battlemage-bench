#!/bin/bash
# Top-level orchestrator: walks matrix.json's cells, pauses before each card
# switch to have the operator confirm the right physical GPU is active (not
# auto-detected), and calls run-llamacpp.sh/run-vllm.sh for each cell — all
# appending to one shared results JSONL for the session.
#
# Usage:
#   ./run-matrix.sh \
#     --llamacpp-model-path /path/model.gguf --llamacpp-model-name "Name" --llamacpp-quantization "Q4_K_M" \
#     --vllm-model /path-or-hf-id --vllm-model-name "Name" --vllm-quantization "AWQ-4bit" \
#     [--resume] [--llamacpp-recipe <name>] [--vllm-recipe <name>] [--repeats 4] [--concurrency-levels 1,2,4,8,16] \
#     [--context-lengths 8192,65536,131072] [--prefill-lengths 256,7936] \
#     [--card B70] [--results-file results/<timestamp>.jsonl]
#
# --card restricts the run to cells for just one card (e.g. only B70 is
# physically installed right now) — omit it to run every card in
# matrix.json.
#
# Model/quant have no defaults — the site's methodology doesn't force
# llama.cpp and vLLM to use equivalent model/quant formats, so both must be
# given explicitly.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATRIX_FILE="$SCRIPT_DIR/matrix.json"

usage() {
  cat <<'EOF'
Usage: run-matrix.sh \
  --llamacpp-model-path <gguf> --llamacpp-model-name <name> --llamacpp-quantization <quant> \
  --vllm-model <path-or-hf-id> --vllm-model-name <name> --vllm-quantization <quant> \
  [--resume] [--llamacpp-recipe <name>] [--vllm-recipe <name>] [--repeats 4] [--concurrency-levels 1,2,4,8,16] \
  [--context-lengths 8192,65536,131072] [--prefill-lengths 256,7936] \
  [--card B70] [--results-file <path>]

Runs every cell in matrix.json in turn (or only the cells for --card, if
given), sweeping context length x concurrency x prefill length within each.
Pauses before each card switch and asks you to confirm the right physical
GPU is active — card selection is never auto-detected.

Combinations with no room for the prefill are skipped by the per-runtime
scripts and listed in their end-of-sweep summaries.

--resume skips cells already present in --results-file, matched on card,
backend, runtime, model, context, concurrency and prefill. Point it at the
results file from the interrupted run and it picks up where that stopped —
including skipping the model load for a cell that is already complete.

--llamacpp-recipe / --vllm-recipe select which script in recipes/ supplies
the launch flags. They default to the "balanced" profile for each runtime and
backend, which is what the published numbers are measured with.
EOF
  exit 1
}

LLAMACPP_MODEL_PATH=""
LLAMACPP_MODEL_NAME=""
LLAMACPP_QUANTIZATION=""
VLLM_MODEL=""
VLLM_MODEL_NAME=""
VLLM_QUANTIZATION=""
RESUME=""
LLAMACPP_RECIPE=""
VLLM_RECIPE=""
REPEATS=""
CONCURRENCY_LEVELS=""
CONTEXT_LENGTHS=""
PREFILL_LENGTHS=""
CARD_FILTER=""
RESULTS_FILE="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S).jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --llamacpp-model-path) LLAMACPP_MODEL_PATH="$2"; shift 2 ;;
    --llamacpp-model-name) LLAMACPP_MODEL_NAME="$2"; shift 2 ;;
    --llamacpp-quantization) LLAMACPP_QUANTIZATION="$2"; shift 2 ;;
    --vllm-model) VLLM_MODEL="$2"; shift 2 ;;
    --vllm-model-name) VLLM_MODEL_NAME="$2"; shift 2 ;;
    --vllm-quantization) VLLM_QUANTIZATION="$2"; shift 2 ;;
    --resume) RESUME="--resume"; shift ;;
    --llamacpp-recipe) LLAMACPP_RECIPE="$2"; shift 2 ;;
    --vllm-recipe) VLLM_RECIPE="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --concurrency-levels) CONCURRENCY_LEVELS="$2"; shift 2 ;;
    --context-lengths) CONTEXT_LENGTHS="$2"; shift 2 ;;
    --prefill-lengths) PREFILL_LENGTHS="$2"; shift 2 ;;
    --card) CARD_FILTER="$2"; shift 2 ;;
    --results-file) RESULTS_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$LLAMACPP_MODEL_PATH" || -z "$LLAMACPP_MODEL_NAME" || -z "$LLAMACPP_QUANTIZATION" ]] && usage
[[ -z "$VLLM_MODEL" || -z "$VLLM_MODEL_NAME" || -z "$VLLM_QUANTIZATION" ]] && usage

read -r DEFAULT_CONCURRENCY DEFAULT_CONTEXTS DEFAULT_PREFILLS DEFAULT_REPEATS <<< "$(node -e "
  const m = require('$MATRIX_FILE');
  console.log([
    m.concurrency_default.join(','),
    m.context_lengths_default.join(','),
    m.prefill_lengths_default.join(','),
    m.repeats_default,
  ].join(' '));
")"
CONCURRENCY_LEVELS="${CONCURRENCY_LEVELS:-$DEFAULT_CONCURRENCY}"
CONTEXT_LENGTHS="${CONTEXT_LENGTHS:-$DEFAULT_CONTEXTS}"
PREFILL_LENGTHS="${PREFILL_LENGTHS:-$DEFAULT_PREFILLS}"
REPEATS="${REPEATS:-$DEFAULT_REPEATS}"

echo "Caching system info..."
"$SCRIPT_DIR/collect-system-info.sh" > /dev/null

CELLS=$(node -e "
  const m = require('$MATRIX_FILE');
  const cardFilter = process.argv[1] || null;
  m.cells
    .filter((c) => !cardFilter || c.card === cardFilter)
    .forEach((c) => console.log(c.card + '|' + c.backend + '|' + c.runtime));
" "$CARD_FILTER")

if [[ -z "$CELLS" ]]; then
  echo "No cells match --card '$CARD_FILTER' in $MATRIX_FILE — nothing to run."
  exit 1
fi

LAST_CARD=""
# Cells are read from fd 3, not stdin: the card-switch confirmation below
# does `read -rp` on stdin, and if the loop's own `read` were also on stdin
# they'd share one cursor — the confirmation prompt would silently consume
# the next cell line as its "press enter" input. That happened here before:
# every non-first cell of a card switch (i.e. cell 2 of every card, since the
# switch always fires on a card's first cell) vanished with no error.
while IFS='|' read -r CARD BACKEND RUNTIME <&3; do
  [[ -z "$CARD" ]] && continue

  if [[ "$CARD" != "$LAST_CARD" ]]; then
    echo ""
    echo "############################################"
    echo "# Next up: card = $CARD"
    echo "# Make sure the $CARD is the active/only GPU (physical swap, or the"
    echo "# right device-selector env var if both are installed at once)."
    echo "############################################"
    read -rp "Press Enter once $CARD is active (or Ctrl+C to stop)... "
    LAST_CARD="$CARD"
  fi

  echo ""
  echo ">>> Cell: $CARD / $BACKEND / $RUNTIME"

  case "$RUNTIME" in
    "llama.cpp")
      "$SCRIPT_DIR/run-llamacpp.sh" \
        --backend "$BACKEND" --card "$CARD" \
        --model-path "$LLAMACPP_MODEL_PATH" --model-name "$LLAMACPP_MODEL_NAME" \
        --quantization "$LLAMACPP_QUANTIZATION" \
        ${LLAMACPP_RECIPE:+--recipe "$LLAMACPP_RECIPE"} \
        --concurrency-levels "$CONCURRENCY_LEVELS" --repeats "$REPEATS" \
        --ctx-sizes "$CONTEXT_LENGTHS" --prefill-lengths "$PREFILL_LENGTHS" \
        $RESUME \
        --results-file "$RESULTS_FILE"
      ;;
    "vLLM")
      "$SCRIPT_DIR/run-vllm.sh" \
        --card "$CARD" \
        --model "$VLLM_MODEL" --model-name "$VLLM_MODEL_NAME" \
        --quantization "$VLLM_QUANTIZATION" \
        ${VLLM_RECIPE:+--recipe "$VLLM_RECIPE"} \
        --concurrency-levels "$CONCURRENCY_LEVELS" --repeats "$REPEATS" \
        --max-model-lens "$CONTEXT_LENGTHS" --prefill-lengths "$PREFILL_LENGTHS" \
        $RESUME \
        --results-file "$RESULTS_FILE"
      ;;
    *)
      echo "Unknown runtime in matrix.json: $RUNTIME — skipping"
      ;;
  esac
done 3<<< "$CELLS"

echo ""
echo "Matrix run complete. All results in $RESULTS_FILE"
echo "Review with:  node $SCRIPT_DIR/submit-jsonl.js --file $RESULTS_FILE --dry-run"
echo "Submit with:  node $SCRIPT_DIR/submit-jsonl.js --file $RESULTS_FILE --base-url http://localhost:3000"
