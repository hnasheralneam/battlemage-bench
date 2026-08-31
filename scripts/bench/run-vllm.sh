#!/bin/bash
# Runs the vLLM benchmark sweep for one card (SYCL/XPU only — vLLM has no
# Vulkan backend on Intel GPUs) across a set of concurrency levels, N
# repeats each (first repeat discarded as warmup, median reported), via
# `vllm bench serve` against one running `vllm serve` instance.
#
# NOTE: vllm-serve-launch.sh is a placeholder, not a real tuned command like
# the llama.cpp launch scripts — fill in your actual vLLM invocation there
# before running this for real.
#
# Usage:
#   ./run-vllm.sh --card B70|B65 \
#     --model /path-or-hf-id --model-name "Name" --quantization "AWQ-4bit" \
#     [--concurrency-levels 1,2,4,8,16] [--repeats 3] \
#     [--max-model-len 32768] [--num-prompts-per-level <n>] \
#     [--port 8091] [--results-file results/<timestamp>.jsonl]

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: run-vllm.sh --card <B70|B65> \
  --model <path-or-hf-id> --model-name <name> --quantization <quant> \
  [--concurrency-levels 1,2,4,8,16] [--repeats 3] [--max-model-len 32768] \
  [--num-prompts-per-level <n>] [--port 8091] [--results-file <path>]

Backend is always SYCL — vLLM has no Vulkan backend on Intel GPUs.
--card is not auto-detected: make sure the right GPU is actually active.
--num-prompts-per-level defaults to 10x the concurrency level if unset.
EOF
  exit 1
}

CARD=""
MODEL=""
MODEL_NAME=""
QUANTIZATION=""
CONCURRENCY_LEVELS="1,2,4,8,16"
REPEATS=3
MAX_MODEL_LEN=32768
NUM_PROMPTS_PER_LEVEL=""
PORT=8091
RESULTS_FILE="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S).jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --card) CARD="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --model-name) MODEL_NAME="$2"; shift 2 ;;
    --quantization) QUANTIZATION="$2"; shift 2 ;;
    --concurrency-levels) CONCURRENCY_LEVELS="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --max-model-len) MAX_MODEL_LEN="$2"; shift 2 ;;
    --num-prompts-per-level) NUM_PROMPTS_PER_LEVEL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --results-file) RESULTS_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$CARD" || -z "$MODEL" || -z "$MODEL_NAME" || -z "$QUANTIZATION" ]] && usage

RUNTIME_VERSION="unknown"
if command -v python3 >/dev/null 2>&1; then
  RUNTIME_VERSION=$(python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")
fi

SYSTEM_INFO_FILE="$SCRIPT_DIR/cache/system-info.json"
if [[ ! -f "$SYSTEM_INFO_FILE" ]]; then
  echo "System info not cached yet — running collect-system-info.sh..."
  "$SCRIPT_DIR/collect-system-info.sh" > /dev/null
fi

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

FULL_COMMAND_LAUNCH="VLLM_MODEL=$MODEL VLLM_PORT=$PORT VLLM_MAX_MODEL_LEN=$MAX_MODEL_LEN $SCRIPT_DIR/vllm-serve-launch.sh"

echo "Starting vLLM server (model load can take a while)..."
SERVER_LOG=$(mktemp)
VLLM_MODEL="$MODEL" VLLM_PORT="$PORT" VLLM_MAX_MODEL_LEN="$MAX_MODEL_LEN" \
  "$SCRIPT_DIR/vllm-serve-launch.sh" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

IFS=',' read -ra LEVELS <<< "$CONCURRENCY_LEVELS"

READY=0
for i in $(seq 1 180); do  # vLLM model load can be slow — generous timeout
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 2
done

if [[ "$READY" -ne 1 ]]; then
  echo "vLLM server did not become healthy — recording every concurrency level as crashed"
  tail -30 "$SERVER_LOG"
  kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
  for N in "${LEVELS[@]}"; do
    node "$SCRIPT_DIR/lib/emit-submission.js" \
      --results-file "$RESULTS_FILE" \
      --card "$CARD" --backend SYCL --runtime "vLLM" \
      --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
      --concurrency "$N" --context-length "$MAX_MODEL_LEN" \
      --full-command "$FULL_COMMAND_LAUNCH" \
      --runtime-version "$RUNTIME_VERSION" \
      --system-info-file "$SYSTEM_INFO_FILE" \
      --crashed 1 \
      --stability-notes "vLLM server did not become healthy within 360s." \
      --repeats-json '[{"generation_tok_s":0,"prompt_eval_tok_s":0}]'
  done
  rm -f "$SERVER_LOG"
  exit 1
fi

for N in "${LEVELS[@]}"; do
  echo "=== $CARD / SYCL / vLLM @ concurrency=$N ==="
  NUM_PROMPTS="${NUM_PROMPTS_PER_LEVEL:-$((N * 10))}"
  BENCH_COMMAND="vllm bench serve --backend vllm --base-url http://localhost:$PORT --model $MODEL --max-concurrency $N --num-prompts $NUM_PROMPTS"

  REPEATS_LOG=$(mktemp)
  for r in $(seq 1 "$REPEATS"); do
    echo "  repeat $r/$REPEATS..."
    RESULT_JSON=$(mktemp --suffix=.json)
    $BENCH_COMMAND --save-result --result-filename "$RESULT_JSON" > /dev/null 2>&1
    node "$SCRIPT_DIR/lib/parse-vllm-result.js" "$RESULT_JSON" >> "$REPEATS_LOG"
    rm -f "$RESULT_JSON"
  done

  REPEATS_JSON=$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$REPEATS_LOG', 'utf8').split('\n').filter(Boolean);
    console.log(JSON.stringify(lines.map((l) => JSON.parse(l))));
  ")

  ANY_ZERO_COMPLETED=$(node -e "
    const arr = $REPEATS_JSON;
    console.log(arr.some((r) => r.generation_tok_s === 0 && r.source === 'unreadable') ? '1' : '0');
  ")
  CRASHED_FLAG=0
  STABILITY_NOTES=""
  if [[ "$ANY_ZERO_COMPLETED" == "1" ]]; then
    CRASHED_FLAG=1
    STABILITY_NOTES="One or more repeats produced no readable vllm bench serve result at this concurrency level."
  fi

  node "$SCRIPT_DIR/lib/emit-submission.js" \
    --results-file "$RESULTS_FILE" \
    --card "$CARD" --backend SYCL --runtime vLLM \
    --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
    --concurrency "$N" --context-length "$MAX_MODEL_LEN" \
    --full-command "$BENCH_COMMAND (server: $FULL_COMMAND_LAUNCH)" \
    --runtime-version "$RUNTIME_VERSION" \
    --system-info-file "$SYSTEM_INFO_FILE" \
    --crashed "$CRASHED_FLAG" \
    --stability-notes "$STABILITY_NOTES" \
    --repeats-json "$REPEATS_JSON"

  rm -f "$REPEATS_LOG"
done

kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
rm -f "$SERVER_LOG"

echo ""
echo "Done. Results appended to $RESULTS_FILE"
