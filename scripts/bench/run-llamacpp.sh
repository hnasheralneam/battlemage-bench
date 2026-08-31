#!/bin/bash
# Runs the llama.cpp benchmark sweep for one (backend, card) pair across a
# set of concurrency levels — N repeats each (first repeat discarded as
# warmup, median of the rest reported) — and appends one submission-ready
# row per concurrency level to the results JSONL via emit-submission.js.
#
# Usage:
#   ./run-llamacpp.sh --backend Vulkan|SYCL --card B70|B65 \
#     --model-path /path/to/model.gguf --model-name "Name" \
#     --quantization Q4_K_M \
#     [--concurrency-levels 1,2,4,8,16] [--repeats 3] \
#     [--ctx-size 221760] [--duration 20] [--max-tokens 128] \
#     [--port 8090] [--results-file results/<timestamp>.jsonl]

set -uo pipefail  # not -e: one failed concurrency level shouldn't abort the whole sweep

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: run-llamacpp.sh --backend <Vulkan|SYCL> --card <B70|B65> \
  --model-path <path> --model-name <name> --quantization <quant> \
  [--concurrency-levels 1,2,4,8,16] [--repeats 3] [--ctx-size 221760] \
  [--duration 20] [--max-tokens 128] [--port 8090] \
  [--results-file <path>]

--card is not auto-detected: you are responsible for making sure the GPU
you name here is actually the one active (physical swap, or a device
selector env var — see the comments in llama-server-launch.*.sh).
EOF
  exit 1
}

BACKEND=""
CARD=""
MODEL_PATH=""
MODEL_NAME=""
QUANTIZATION=""
CONCURRENCY_LEVELS="1,2,4,8,16"
REPEATS=3
CTX_SIZE=221760
DURATION=20
MAX_TOKENS=128
PORT=8090
RESULTS_FILE="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S).jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend) BACKEND="$2"; shift 2 ;;
    --card) CARD="$2"; shift 2 ;;
    --model-path) MODEL_PATH="$2"; shift 2 ;;
    --model-name) MODEL_NAME="$2"; shift 2 ;;
    --quantization) QUANTIZATION="$2"; shift 2 ;;
    --concurrency-levels) CONCURRENCY_LEVELS="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --ctx-size) CTX_SIZE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --max-tokens) MAX_TOKENS="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --results-file) RESULTS_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$BACKEND" || -z "$CARD" || -z "$MODEL_PATH" || -z "$MODEL_NAME" || -z "$QUANTIZATION" ]] && usage

case "$BACKEND" in
  Vulkan) LAUNCH_SCRIPT="$SCRIPT_DIR/llama-server-launch.vulkan.sh"; CHECKOUT_VAR="LLAMACPP_VULKAN_DIR"; DEFAULT_DIR="$HOME/llama.cpp-vulkan" ;;
  SYCL)   LAUNCH_SCRIPT="$SCRIPT_DIR/llama-server-launch.sycl.sh";   CHECKOUT_VAR="LLAMACPP_SYCL_DIR";   DEFAULT_DIR="$HOME/llama.cpp-sycl" ;;
  *) echo "--backend must be Vulkan or SYCL"; exit 1 ;;
esac

CHECKOUT_DIR="${!CHECKOUT_VAR:-$DEFAULT_DIR}"
RUNTIME_VERSION="unknown"
if [[ -d "$CHECKOUT_DIR/.git" ]]; then
  RUNTIME_VERSION=$(git -C "$CHECKOUT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
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

IFS=',' read -ra LEVELS <<< "$CONCURRENCY_LEVELS"

for N in "${LEVELS[@]}"; do
  echo "=== $CARD / $BACKEND / llama.cpp @ concurrency=$N ==="

  LOG_FILE=$(mktemp)
  env "$CHECKOUT_VAR=$CHECKOUT_DIR" \
    LLAMA_MODEL_PATH="$MODEL_PATH" \
    LLAMA_MODEL_ALIAS="$MODEL_NAME" \
    LLAMA_PARALLEL="$N" \
    LLAMA_PORT="$PORT" \
    LLAMA_CTX_SIZE="$CTX_SIZE" \
    "$LAUNCH_SCRIPT" > "$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  READY=0
  for i in $(seq 1 60); do
    if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
      READY=1
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  FULL_COMMAND="$CHECKOUT_VAR=$CHECKOUT_DIR LLAMA_MODEL_PATH=$MODEL_PATH LLAMA_MODEL_ALIAS=$MODEL_NAME LLAMA_PARALLEL=$N LLAMA_PORT=$PORT LLAMA_CTX_SIZE=$CTX_SIZE $LAUNCH_SCRIPT"

  if [[ "$READY" -ne 1 ]]; then
    echo "  server did not become healthy within 60s — recording as crashed, skipping load test"
    tail -20 "$LOG_FILE"
    kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
    node "$SCRIPT_DIR/lib/emit-submission.js" \
      --results-file "$RESULTS_FILE" \
      --card "$CARD" --backend "$BACKEND" --runtime "llama.cpp" \
      --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
      --concurrency "$N" --context-length "$CTX_SIZE" \
      --full-command "$FULL_COMMAND" \
      --flash-attention on \
      --runtime-version "$RUNTIME_VERSION" \
      --system-info-file "$SYSTEM_INFO_FILE" \
      --crashed 1 \
      --stability-notes "Server did not become healthy within 60s at this concurrency level." \
      --repeats-json '[{"generation_tok_s":0,"prompt_eval_tok_s":0}]'
    rm -f "$LOG_FILE"
    continue
  fi

  REPEATS_LOG=$(mktemp)
  for r in $(seq 1 "$REPEATS"); do
    echo "  repeat $r/$REPEATS..."
    node "$SCRIPT_DIR/lib/load-llamacpp.js" \
      --base-url "http://localhost:$PORT" \
      --concurrency "$N" --duration "$DURATION" --max-tokens "$MAX_TOKENS" \
      >> "$REPEATS_LOG"
  done

  REPEATS_JSON=$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$REPEATS_LOG', 'utf8').split('\n').filter(Boolean);
    console.log(JSON.stringify(lines.map((l) => JSON.parse(l))));
  ")

  kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""

  ANY_ZERO_COMPLETED=$(node -e "
    const arr = $REPEATS_JSON;
    console.log(arr.some((r) => (r.requests_completed || 0) === 0) ? '1' : '0');
  ")
  CRASHED_FLAG=0
  STABILITY_NOTES=""
  if [[ "$ANY_ZERO_COMPLETED" == "1" ]]; then
    CRASHED_FLAG=1
    STABILITY_NOTES="One or more repeats had zero successful requests at this concurrency level — possible crash/hang mid-run."
  fi

  node "$SCRIPT_DIR/lib/emit-submission.js" \
    --results-file "$RESULTS_FILE" \
    --card "$CARD" --backend "$BACKEND" --runtime "llama.cpp" \
    --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
    --concurrency "$N" --context-length "$CTX_SIZE" \
    --full-command "$FULL_COMMAND" \
    --flash-attention on \
    --runtime-version "$RUNTIME_VERSION" \
    --system-info-file "$SYSTEM_INFO_FILE" \
    --crashed "$CRASHED_FLAG" \
    --stability-notes "$STABILITY_NOTES" \
    --repeats-json "$REPEATS_JSON"

  rm -f "$LOG_FILE" "$REPEATS_LOG"
done

echo ""
echo "Done. Results appended to $RESULTS_FILE"
