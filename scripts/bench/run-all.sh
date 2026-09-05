#!/bin/bash
# The single command for a full sweep handoff: runs every model in a models
# manifest across every card in matrix.json, card outermost and largest
# context first (see REMOTE_AGENT_PROMPT.md's "Running the sweep" for why
# that order is deliberate), one results file per (card, model), then prints
# every results file wrapped for the agent to hand back plus a plain-English
# summary via lib/summarize-results.js.
#
# This is a thin wrapper around run-matrix.sh — it does not sweep anything
# itself. It exists because the site's own three-model sweep is six
# run-matrix.sh invocations with a specific order, and getting that order
# right by hand (paste error, wrong --card, wrong --results-file) is exactly
# the kind of mistake that is expensive to notice nine hours in.
#
# Usage:
#   ./run-all.sh [--models-file models.json] [--card B70] [--resume] \
#     [--results-dir results] \
#     [--context-lengths 131072,65536,8192] [--concurrency-levels 1,2,4,8,16] \
#     [--prefill-lengths 256,7936] [--repeats 4] \
#     [--llamacpp-recipe <name>] [--vllm-recipe <name>]
#
# models.json (see models.example.json): a JSON object with a "models" array,
# each entry {name, llamacpp_model_path, llamacpp_quantization, vllm_model,
# vllm_quantization}. `name` is used as --model-name for both runtimes.
#
# Omit --card to run every card in matrix.json, prompting once per card
# before starting that card's three models. Pass --card to restrict to one
# (do this if only one card is physically installed).

set -uo pipefail  # not -e: one bad model shouldn't abort the rest of the sweep

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATRIX_FILE="$SCRIPT_DIR/matrix.json"

usage() {
  cat <<'EOF'
Usage: run-all.sh [--models-file models.json] [--card B70] [--resume]
  [--results-dir results]
  [--context-lengths 131072,65536,8192] [--concurrency-levels 1,2,4,8,16]
  [--prefill-lengths 256,7936] [--repeats 4]
  [--llamacpp-recipe <name>] [--vllm-recipe <name>]

Runs every model in --models-file across every card in matrix.json (or just
--card, if given), card outermost, largest context first. One results file
per (card, model) under --results-dir. At the end, prints a summary and every
results file wrapped in ===BEGIN/END RESULTS FILE=== markers, ready to relay
back verbatim.

See models.example.json for the manifest format.
EOF
  exit 1
}

MODELS_FILE="$SCRIPT_DIR/models.json"
CARD_FILTER=""
RESUME=""
RESULTS_DIR="$SCRIPT_DIR/results"
CONTEXT_LENGTHS="131072,65536,8192"
CONCURRENCY_LEVELS=""
PREFILL_LENGTHS=""
REPEATS=""
LLAMACPP_RECIPE=""
VLLM_RECIPE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-file) MODELS_FILE="$2"; shift 2 ;;
    --card) CARD_FILTER="$2"; shift 2 ;;
    --resume) RESUME="--resume"; shift ;;
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    --context-lengths) CONTEXT_LENGTHS="$2"; shift 2 ;;
    --concurrency-levels) CONCURRENCY_LEVELS="$2"; shift 2 ;;
    --prefill-lengths) PREFILL_LENGTHS="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --llamacpp-recipe) LLAMACPP_RECIPE="$2"; shift 2 ;;
    --vllm-recipe) VLLM_RECIPE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

if [[ ! -f "$MODELS_FILE" ]]; then
  echo "Models manifest not found: $MODELS_FILE"
  echo "Copy scripts/bench/models.example.json to $MODELS_FILE and fill in real paths."
  exit 1
fi

# Validate the manifest and pull it into a shell-parseable form: one line per
# model, tab-separated, so paths with spaces survive `read`.
MODEL_ROWS="$(node -e "
  const m = require(require('path').resolve('$MODELS_FILE'));
  if (!Array.isArray(m.models) || m.models.length === 0) {
    console.error('models.json: no \"models\" array, or it is empty');
    process.exit(1);
  }
  for (const model of m.models) {
    for (const key of ['name','llamacpp_model_path','llamacpp_quantization','vllm_model','vllm_quantization']) {
      if (!model[key]) {
        console.error(\`models.json: model missing required field \"\${key}\": \${JSON.stringify(model)}\`);
        process.exit(1);
      }
    }
    console.log([model.name, model.llamacpp_model_path, model.llamacpp_quantization, model.vllm_model, model.vllm_quantization].join('\t'));
  }
")"
if [[ $? -ne 0 ]]; then
  exit 1
fi

CARDS="$(node -e "
  const m = require('$MATRIX_FILE');
  const filter = process.argv[1] || null;
  const seen = new Set();
  for (const c of m.cells) {
    if (filter && c.card !== filter) continue;
    if (!seen.has(c.card)) { seen.add(c.card); console.log(c.card); }
  }
" "$CARD_FILTER")"
if [[ -z "$CARDS" ]]; then
  echo "No cards match --card '$CARD_FILTER' in $MATRIX_FILE"
  exit 1
fi

slugify() {
  # printf, not echo: echo's trailing newline is itself non-alnum and would
  # tr into a trailing '-' on every slug.
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed -e 's/^-//' -e 's/-$//'
}

mkdir -p "$RESULTS_DIR"
RESULTS_FILES=()
FAILED_INVOCATIONS=()

while IFS= read -r CARD <&3; do
  [[ -z "$CARD" ]] && continue
  echo ""
  echo "################################################################"
  echo "# CARD BATCH: $CARD — all models below run on $CARD before the"
  echo "# next card starts. Physically swap (or set ONEAPI_DEVICE_SELECTOR)"
  echo "# now if this isn't already the active card."
  echo "################################################################"
  read -rp "Press Enter once $CARD is confirmed active (or Ctrl+C to stop)... "
  # (fd 3, not stdin, above: the read -rp here needs stdin free — see the
  # comment on the equivalent fix in run-matrix.sh.)

  while IFS=$'\t' read -r NAME LLAMACPP_PATH LLAMACPP_QUANT VLLM_MODEL VLLM_QUANT; do
    [[ -z "$NAME" ]] && continue
    SLUG="$(slugify "$CARD")-$(slugify "$NAME")"
    RESULTS_FILE="$RESULTS_DIR/$SLUG.jsonl"
    RESULTS_FILES+=("$RESULTS_FILE")

    echo ""
    echo ">>> $CARD / $NAME -> $RESULTS_FILE"
    "$SCRIPT_DIR/run-matrix.sh" \
      --card "$CARD" \
      --context-lengths "$CONTEXT_LENGTHS" \
      --llamacpp-model-path "$LLAMACPP_PATH" --llamacpp-model-name "$NAME" --llamacpp-quantization "$LLAMACPP_QUANT" \
      --vllm-model "$VLLM_MODEL" --vllm-model-name "$NAME" --vllm-quantization "$VLLM_QUANT" \
      --results-file "$RESULTS_FILE" \
      $RESUME \
      ${CONCURRENCY_LEVELS:+--concurrency-levels "$CONCURRENCY_LEVELS"} \
      ${PREFILL_LENGTHS:+--prefill-lengths "$PREFILL_LENGTHS"} \
      ${REPEATS:+--repeats "$REPEATS"} \
      ${LLAMACPP_RECIPE:+--llamacpp-recipe "$LLAMACPP_RECIPE"} \
      ${VLLM_RECIPE:+--vllm-recipe "$VLLM_RECIPE"}

    if [[ $? -ne 0 ]]; then
      echo "!!! run-matrix.sh exited non-zero for $CARD / $NAME — see output above. Continuing with the next model."
      FAILED_INVOCATIONS+=("$CARD / $NAME")
    fi
  done <<< "$MODEL_ROWS"
done 3<<< "$CARDS"

echo ""
echo "################################################################"
echo "# Sweep complete. Summary:"
echo "################################################################"
SUMMARY_ARGS=()
for f in "${RESULTS_FILES[@]}"; do SUMMARY_ARGS+=(--file "$f"); done
node "$SCRIPT_DIR/lib/summarize-results.js" "${SUMMARY_ARGS[@]}"

if [[ ${#FAILED_INVOCATIONS[@]} -gt 0 ]]; then
  echo ""
  echo "!!! These invocations exited non-zero and need a look before you report clean:"
  for f in "${FAILED_INVOCATIONS[@]}"; do echo "  - $f"; done
fi

echo ""
echo "################################################################"
echo "# Paste everything below back, verbatim, per REMOTE_AGENT_PROMPT.md"
echo "################################################################"
for f in "${RESULTS_FILES[@]}"; do
  echo ""
  echo "===BEGIN RESULTS FILE: $f==="
  if [[ -f "$f" ]]; then
    cat "$f"
  else
    echo "(no file — no cells for this model/card ran; see summary above)"
  fi
  echo "===END RESULTS FILE==="
done
