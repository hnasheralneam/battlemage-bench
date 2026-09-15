#!/bin/bash
# Runs the llama.cpp benchmark sweep for one (backend, card) pair across
# three crossed axes — context size, concurrency, and prefill length — with N
# repeats each (first repeat discarded as warmup, median of the rest
# reported), appending one submission-ready row per feasible cell to the
# results JSONL via emit-submission.js.
#
# Context size and concurrency are both llama-server launch flags, so each
# (ctx, concurrency) pair costs one server start; prefill length is a
# property of the requests, so every prefill level runs against that same
# server.
#
# Not every combination is runnable: --ctx-size is a total KV budget split
# evenly across the parallel slots, so a slot only has ctx/concurrency tokens
# to hold the prompt *and* what it generates. Cells without room are skipped
# and tallied, never run truncated — a truncated prompt would quietly measure
# a different prefill length than the one recorded.
#
# Usage:
#   ./run-llamacpp.sh --backend Vulkan|SYCL|OpenVINO --card B70|B65 \
#     --model-path /path/to/model.gguf --model-name "Name" \
#     --quantization Q4_K_M \
#     [--concurrency-levels 1,2,4,8,16] [--repeats 4] \
#     [--ctx-sizes 8192,65536,131072] [--prefill-lengths 256,7936] \
#     [--duration 20] [--max-tokens 256] \
#     [--recipe llamacpp-<backend>-balanced] [--mtp on|off|unknown] \
#     [--resume] [--port 8090] [--results-file results/<timestamp>.jsonl]
#
# --mtp is metadata only, forwarded as-is to emit-submission.js — it does not
# itself turn MTP on. To actually run MTP, pass --recipe llamacpp-vulkan-mtp
# and export LLAMA_DRAFT_MODEL_PATH (and optionally LLAMA_SPEC_DRAFT_N_MAX);
# then also pass --mtp on so the row records that accurately instead of the
# default "unknown".

set -uo pipefail  # not -e: one failed cell shouldn't abort the whole sweep

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage: run-llamacpp.sh --backend <Vulkan|SYCL|OpenVINO> --card <B70|B65> \
  --model-path <path> --model-name <name> --quantization <quant> \
  [--concurrency-levels 1,2,4,8,16] [--repeats 4] \
  [--ctx-sizes 8192,65536,131072] [--prefill-lengths 256,7936] \
  [--duration 20] [--max-tokens 256] [--recipe llamacpp-<backend>-balanced] [--resume] [--port 8090] \
  [--results-file <path>]

--card is not auto-detected: you are responsible for making sure the GPU
you name here is actually the one active (physical swap, or a device
selector env var — see the comments in llama-server-launch.*.sh).

A cell runs only when ctx >= prefill + max-tokens; anything tighter is
skipped and reported in the summary at the end. Concurrency does not divide
the budget: the launch scripts use a unified KV cache (-kvu).
EOF
  exit 1
}

BACKEND=""
CARD=""
MODEL_PATH=""
MODEL_NAME=""
QUANTIZATION=""
CONCURRENCY_LEVELS="1,2,4,8,16"
REPEATS=4
CTX_SIZES="8192,65536,131072"
PREFILL_LENGTHS="256,7936"
DURATION=20
MAX_TOKENS=256
RESUME=0
RECIPE=""
MTP="unknown"  # forwarded as-is to emit-submission.js; pass --mtp on when running an -mtp recipe
PORT=18090  # 8080-8094ish are occupied by other services on this box — see HANDOFF-PLAN.md
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
    --ctx-sizes) CTX_SIZES="$2"; shift 2 ;;
    --prefill-lengths) PREFILL_LENGTHS="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --max-tokens) MAX_TOKENS="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --recipe) RECIPE="$2"; shift 2 ;;
    --mtp) MTP="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --results-file) RESULTS_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$BACKEND" || -z "$CARD" || -z "$MODEL_PATH" || -z "$MODEL_NAME" || -z "$QUANTIZATION" ]] && usage

LAUNCH_SCRIPT="$SCRIPT_DIR/llama-server-launch.sh"
case "$BACKEND" in
  Vulkan)   CHECKOUT_VAR="LLAMACPP_VULKAN_DIR";   DEFAULT_DIR="$HOME/llama.cpp-vulkan"; RECIPE_BACKEND_SLUG="vulkan" ;;
  SYCL)     CHECKOUT_VAR="LLAMACPP_SYCL_DIR";     DEFAULT_DIR="$HOME/llama.cpp-sycl";   RECIPE_BACKEND_SLUG="sycl" ;;
  OpenVINO) CHECKOUT_VAR="LLAMACPP_OPENVINO_DIR"; DEFAULT_DIR="$HOME/llama.cpp-vulkan"; RECIPE_BACKEND_SLUG="openvino" ;;
  *) echo "--backend must be Vulkan, SYCL, or OpenVINO"; exit 1 ;;
esac

# Every flag except the swept axes comes from a recipe in ../../recipes, so a
# published number is always attributable to a recipe someone can copy.
RECIPE="${RECIPE:-llamacpp-$RECIPE_BACKEND_SLUG-balanced}"
RECIPE_FILE="$REPO_ROOT/recipes/$RECIPE.sh"
if [[ ! -f "$RECIPE_FILE" ]]; then
  echo "No such recipe: $RECIPE_FILE"
  echo "Available:"; ls "$REPO_ROOT/recipes"/llamacpp-*.sh | xargs -n1 basename
  exit 1
fi

# Read the recipe's declared KV cache type. Parsed rather than sourced: this
# has to work before the runtime's environment is built (preflight runs it),
# and sourcing a vLLM recipe requires vllm already on PATH. The declaration
# is a plain literal line in every recipe, which is why parsing is safe here.
KV_CACHE_TYPE=$(sed -n 's/^RECIPE_KV_CACHE_TYPE="\(.*\)"$/\1/p' "$RECIPE_FILE" | head -1)
if [[ -z "$KV_CACHE_TYPE" ]]; then
  echo "Warning: no RECIPE_KV_CACHE_TYPE in $RECIPE_FILE — rows will record it as unknown." >&2
fi

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

# SIGTERM, then wait up to 30s (polling, not a blocking `wait`), then SIGKILL
# if it still hasn't exited. A plain `kill; wait` can hang the whole sweep
# indefinitely if the server doesn't respond to SIGTERM promptly -- observed
# with run-vllm.sh's vLLM server on this box (see HANDOFF-PLAN.md); applied
# here too since the failure mode is generic to any server-backed runner.
stop_server() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  echo "  server pid $pid did not exit within 30s of SIGTERM -- sending SIGKILL" >&2
  kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

cleanup() {
  stop_server "$SERVER_PID"
}
trap cleanup EXIT INT TERM

IFS=',' read -ra LEVELS <<< "$CONCURRENCY_LEVELS"
IFS=',' read -ra CTX_LEVELS <<< "$CTX_SIZES"
IFS=',' read -ra PREFILL_LEVELS <<< "$PREFILL_LENGTHS"

CELLS_RUN=0
CELLS_SKIPPED=0
CELLS_RESUMED=0
SKIP_LOG=()

for CTX_SIZE in "${CTX_LEVELS[@]}"; do
for N in "${LEVELS[@]}"; do
  # Which prefill levels leave room for the tokens they have to generate?
  # The launch scripts run llama-server with -kvu (unified KV cache), so
  # --ctx-size is one shared budget rather than a total carved into fixed
  # per-slot shares — concurrency does not divide it and so does not enter
  # this test. Same shape as the vLLM branch in run-vllm.sh.
  FEASIBLE=()
  for P in "${PREFILL_LEVELS[@]}"; do
    NEEDED=$(( P + MAX_TOKENS ))
    if (( CTX_SIZE >= NEEDED )); then
      FEASIBLE+=("$P")
    else
      CELLS_SKIPPED=$(( CELLS_SKIPPED + 1 ))
      SKIP_LOG+=("ctx=$CTX_SIZE concurrency=$N prefill=$P (ctx holds $CTX_SIZE, needs $NEEDED)")
    fi
  done

  if (( ${#FEASIBLE[@]} == 0 )); then
    echo "=== $CARD / $BACKEND / llama.cpp @ ctx=$CTX_SIZE, concurrency=$N — no prefill level fits, not starting a server ==="
    continue
  fi

  # --resume: drop prefills already in the results file. Done before the
  # server starts, so a fully-completed cell costs no model load at all —
  # which is most of the wall time in a long sweep.
  if (( RESUME )); then
    REMAINING=()
    for P in "${FEASIBLE[@]}"; do
      if node "$SCRIPT_DIR/lib/has-cell.js" --file "$RESULTS_FILE" \
           --card "$CARD" --backend "$BACKEND" --runtime "llama.cpp" \
           --model-name "$MODEL_NAME" --context-length "$CTX_SIZE" \
           --concurrency "$N" --prompt-tokens "$P"; then
        echo "  resume: ctx=$CTX_SIZE concurrency=$N prefill=$P already recorded, skipping"
        CELLS_RESUMED=$(( CELLS_RESUMED + 1 ))
      else
        REMAINING+=("$P")
      fi
    done
    FEASIBLE=("${REMAINING[@]}")
    if (( ${#FEASIBLE[@]} == 0 )); then
      echo "=== $CARD / $BACKEND / llama.cpp @ ctx=$CTX_SIZE, concurrency=$N — all cells already recorded, not starting a server ==="
      continue
    fi
  fi

  echo "=== $CARD / $BACKEND / llama.cpp @ ctx=$CTX_SIZE, concurrency=$N (prefills: ${FEASIBLE[*]}) ==="

  LOG_FILE=$(mktemp)
  env "$CHECKOUT_VAR=$CHECKOUT_DIR" \
    BENCH_RECIPE="$RECIPE" \
    LLAMA_MODEL_PATH="$MODEL_PATH" \
    LLAMA_MODEL_ALIAS="$MODEL_NAME" \
    LLAMA_PARALLEL="$N" \
    LLAMA_PORT="$PORT" \
    LLAMA_CTX_SIZE="$CTX_SIZE" \
    "$LAUNCH_SCRIPT" > "$LOG_FILE" 2>&1 &
  SERVER_PID=$!

  # 180s (3 min) default, not the original 60s: this box runs another
  # autonomous agent (Hermes) with an hourly cron job that briefly loads its
  # own model onto the same GPU when it believes the GPU is idle — its
  # idle-detection doesn't reliably see this sweep's server mid-startup.
  # That contention window is short enough for vLLM's 360s health-check
  # timeout (see run-vllm.sh) to ride out, but was long enough to blow
  # through the old 60s window here and fail an entire context/backend
  # block outright (confirmed: SYCL's whole 30-cell block failed twice in a
  # row at exactly this hourly boundary, see HANDOFF-PLAN.md's step 6
  # incident notes, 2026-09-12). Not fixable from this side of the fence —
  # just giving ourselves the same margin vLLM already has.
  #
  # OpenVINO needs much more than that: its graph-compile step alone was
  # measured at ~9-10 minutes for a single ~16GB-class model (HANDOFF-PLAN.md,
  # 2026-09-15) — a real cost of this backend, not a contention symptom — so
  # it gets its own, longer default rather than sharing Vulkan/SYCL's.
  HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
  if [[ "$BACKEND" == "OpenVINO" ]]; then
    HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S_OPENVINO:-900}"
  fi
  READY=0
  for i in $(seq 1 "$HEALTH_TIMEOUT_S"); do
    if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
      READY=1
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  LAUNCH_COMMAND="$CHECKOUT_VAR=$CHECKOUT_DIR BENCH_RECIPE=$RECIPE LLAMA_MODEL_PATH=$MODEL_PATH LLAMA_MODEL_ALIAS=$MODEL_NAME LLAMA_PARALLEL=$N LLAMA_PORT=$PORT LLAMA_CTX_SIZE=$CTX_SIZE $LAUNCH_SCRIPT"

  if [[ "$READY" -ne 1 ]]; then
    echo "  server did not become healthy within ${HEALTH_TIMEOUT_S}s — recording as crashed, skipping load test"
    tail -20 "$LOG_FILE"
    stop_server "$SERVER_PID"; SERVER_PID=""
    for P in "${FEASIBLE[@]}"; do
      node "$SCRIPT_DIR/lib/emit-submission.js" \
        --results-file "$RESULTS_FILE" \
        --card "$CARD" --backend "$BACKEND" --runtime "llama.cpp" \
        --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
        --concurrency "$N" --context-length "$CTX_SIZE" --prompt-tokens "$P" \
        --full-command "$LAUNCH_COMMAND" \
        --flash-attention on \
        --recipe "$RECIPE" --kv-cache-type "$KV_CACHE_TYPE" \
        --runtime-version "$RUNTIME_VERSION" \
        --system-info-file "$SYSTEM_INFO_FILE" \
        --mtp "$MTP" \
        --crashed 1 \
        --stability-notes "Server did not become healthy within ${HEALTH_TIMEOUT_S}s at this context size and concurrency level." \
        --repeats-json '[{"generation_tok_s":null,"prompt_eval_tok_s":null}]'
      CELLS_RUN=$(( CELLS_RUN + 1 ))
    done
    rm -f "$LOG_FILE"
    continue
  fi

  for P in "${FEASIBLE[@]}"; do
    echo "  --- prefill=$P tokens ---"

    LOAD_COMMAND="node $SCRIPT_DIR/lib/load-llamacpp.js --base-url http://localhost:$PORT --concurrency $N --duration $DURATION --max-tokens $MAX_TOKENS --prompt-tokens $P"

    REPEATS_LOG=$(mktemp)
    for r in $(seq 1 "$REPEATS"); do
      echo "    repeat $r/$REPEATS..."
      $LOAD_COMMAND >> "$REPEATS_LOG"
    done

    REPEATS_JSON=$(node -e "
      const fs = require('fs');
      const lines = fs.readFileSync('$REPEATS_LOG', 'utf8').split('\n').filter(Boolean);
      console.log(JSON.stringify(lines.map((l) => JSON.parse(l))));
    ")

    ANY_ZERO_COMPLETED=$(node -e "
      const arr = $REPEATS_JSON;
      console.log(arr.some((r) => (r.requests_completed || 0) === 0) ? '1' : '0');
    ")
    CRASHED_FLAG=0
    STABILITY_NOTES=""
    if [[ "$ANY_ZERO_COMPLETED" == "1" ]]; then
      CRASHED_FLAG=1
      STABILITY_NOTES="One or more repeats had zero successful requests at this cell — possible crash/hang mid-run."
    fi

    node "$SCRIPT_DIR/lib/emit-submission.js" \
      --results-file "$RESULTS_FILE" \
      --card "$CARD" --backend "$BACKEND" --runtime "llama.cpp" \
      --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
      --concurrency "$N" --context-length "$CTX_SIZE" --prompt-tokens "$P" \
      --full-command "$LAUNCH_COMMAND && $LOAD_COMMAND" \
      --flash-attention on \
      --recipe "$RECIPE" --kv-cache-type "$KV_CACHE_TYPE" \
      --runtime-version "$RUNTIME_VERSION" \
      --system-info-file "$SYSTEM_INFO_FILE" \
      --mtp "$MTP" \
      --crashed "$CRASHED_FLAG" \
      --stability-notes "$STABILITY_NOTES" \
      --repeats-json "$REPEATS_JSON"
    CELLS_RUN=$(( CELLS_RUN + 1 ))

    rm -f "$REPEATS_LOG"
  done

  stop_server "$SERVER_PID"; SERVER_PID=""
  rm -f "$LOG_FILE"
done
done

echo ""
if (( CELLS_SKIPPED > 0 )); then
  echo "Skipped $CELLS_SKIPPED cell(s) with no room for the prefill:"
  printf '  %s\n' "${SKIP_LOG[@]}"
fi
if (( CELLS_RESUMED > 0 )); then
  echo "Resumed: $CELLS_RESUMED cell(s) already present in $RESULTS_FILE, not re-run."
fi
echo "Done. $CELLS_RUN cell(s) appended to $RESULTS_FILE"
