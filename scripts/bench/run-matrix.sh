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
#     [--repeats 3] [--concurrency-levels 1,2,4,8,16] \
#     [--results-file results/<timestamp>.jsonl]
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
  [--repeats 3] [--concurrency-levels 1,2,4,8,16] [--results-file <path>]

Runs every cell in matrix.json in turn. Pauses before each card switch and
asks you to confirm the right physical GPU is active — card selection is
never auto-detected.
EOF
  exit 1
}

LLAMACPP_MODEL_PATH=""
LLAMACPP_MODEL_NAME=""
LLAMACPP_QUANTIZATION=""
VLLM_MODEL=""
VLLM_MODEL_NAME=""
VLLM_QUANTIZATION=""
REPEATS=""
CONCURRENCY_LEVELS=""
RESULTS_FILE="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S).jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --llamacpp-model-path) LLAMACPP_MODEL_PATH="$2"; shift 2 ;;
    --llamacpp-model-name) LLAMACPP_MODEL_NAME="$2"; shift 2 ;;
    --llamacpp-quantization) LLAMACPP_QUANTIZATION="$2"; shift 2 ;;
    --vllm-model) VLLM_MODEL="$2"; shift 2 ;;
    --vllm-model-name) VLLM_MODEL_NAME="$2"; shift 2 ;;
    --vllm-quantization) VLLM_QUANTIZATION="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --concurrency-levels) CONCURRENCY_LEVELS="$2"; shift 2 ;;
    --results-file) RESULTS_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$LLAMACPP_MODEL_PATH" || -z "$LLAMACPP_MODEL_NAME" || -z "$LLAMACPP_QUANTIZATION" ]] && usage
[[ -z "$VLLM_MODEL" || -z "$VLLM_MODEL_NAME" || -z "$VLLM_QUANTIZATION" ]] && usage

read -r DEFAULT_CONCURRENCY DEFAULT_REPEATS <<< "$(node -e "
  const m = require('$MATRIX_FILE');
  console.log(m.concurrency_default.join(',') + ' ' + m.repeats_default);
")"
CONCURRENCY_LEVELS="${CONCURRENCY_LEVELS:-$DEFAULT_CONCURRENCY}"
REPEATS="${REPEATS:-$DEFAULT_REPEATS}"

echo "Caching system info..."
"$SCRIPT_DIR/collect-system-info.sh" > /dev/null

CELLS=$(node -e "
  const m = require('$MATRIX_FILE');
  m.cells.forEach((c) => console.log(c.card + '|' + c.backend + '|' + c.runtime));
")

LAST_CARD=""
while IFS='|' read -r CARD BACKEND RUNTIME; do
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
        --concurrency-levels "$CONCURRENCY_LEVELS" --repeats "$REPEATS" \
        --results-file "$RESULTS_FILE"
      ;;
    "vLLM")
      "$SCRIPT_DIR/run-vllm.sh" \
        --card "$CARD" \
        --model "$VLLM_MODEL" --model-name "$VLLM_MODEL_NAME" \
        --quantization "$VLLM_QUANTIZATION" \
        --concurrency-levels "$CONCURRENCY_LEVELS" --repeats "$REPEATS" \
        --results-file "$RESULTS_FILE"
      ;;
    *)
      echo "Unknown runtime in matrix.json: $RUNTIME — skipping"
      ;;
  esac
done <<< "$CELLS"

echo ""
echo "Matrix run complete. All results in $RESULTS_FILE"
echo "Review with:  node $SCRIPT_DIR/submit-jsonl.js --file $RESULTS_FILE --dry-run"
echo "Submit with:  node $SCRIPT_DIR/submit-jsonl.js --file $RESULTS_FILE --base-url http://localhost:3000"
