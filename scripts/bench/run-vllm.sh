#!/bin/bash
# Runs the vLLM benchmark sweep for one card (SYCL/XPU only — vLLM has no
# Vulkan backend on Intel GPUs) across three crossed axes — max-model-len,
# concurrency, and prefill length — with N repeats each (first repeat
# discarded as warmup, median reported), via `vllm bench serve` against a
# running `vllm serve` instance.
#
# --max-model-len is a `vllm serve` flag, so each context level costs one
# server start (and vLLM's model load is slow); concurrency and prefill are
# both `vllm bench serve` flags, so they run against that same server.
#
# Unlike llama.cpp's --ctx-size, --max-model-len is a per-request ceiling
# that concurrency does not divide — so the feasibility test here is just
# max-model-len >= prefill + output, independent of concurrency. Cells that
# don't fit are skipped and tallied rather than run with a truncated prompt.
#
# NOTE: vllm-serve-launch.sh is a placeholder, not a real tuned command like
# the llama.cpp launch scripts — fill in your actual vLLM invocation there
# before running this for real.
#
# Usage:
#   ./run-vllm.sh --card B70|B65 \
#     --model /path-or-hf-id --model-name "Name" --quantization "AWQ-4bit" \
#     [--concurrency-levels 1,2,4,8,16] [--repeats 4] \
#     [--max-model-lens 8192,65536,131072] [--prefill-lengths 256,7936] \
#     [--max-tokens 256] [--num-prompts-per-level <n>] \
#     [--recipe vllm-sycl-balanced] [--mtp on|off|unknown] \
#     [--resume] [--port 8091] [--results-file results/<timestamp>.jsonl]
#
# --mtp is metadata only, forwarded as-is to emit-submission.js — it does not
# itself turn MTP on. To actually run MTP, pass --recipe vllm-sycl-mtp
# (optionally export VLLM_SPEC_NUM_TOKENS); then also pass --mtp on so the
# row records that accurately instead of the default "unknown".

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage: run-vllm.sh --card <B70|B65> \
  --model <path-or-hf-id> --model-name <name> --quantization <quant> \
  [--concurrency-levels 1,2,4,8,16] [--repeats 4] \
  [--max-model-lens 8192,65536,131072] [--prefill-lengths 256,7936] \
  [--max-tokens 256] [--num-prompts-per-level <n>] [--recipe vllm-sycl-balanced] [--resume] [--port 8091] \
  [--results-file <path>]

Backend is always SYCL — vLLM has no Vulkan backend on Intel GPUs.
--card is not auto-detected: make sure the right GPU is actually active.
--num-prompts-per-level defaults to 10x the concurrency level if unset.

A cell runs only when max-model-len >= prefill + max-tokens; anything
tighter is skipped and reported in the summary at the end.
EOF
  exit 1
}

CARD=""
MODEL=""
MODEL_NAME=""
QUANTIZATION=""
CONCURRENCY_LEVELS="1,2,4,8,16"
REPEATS=4
MAX_MODEL_LENS="8192,65536,131072"
PREFILL_LENGTHS="256,7936"
MAX_TOKENS=256
NUM_PROMPTS_PER_LEVEL=""
RESUME=0
RECIPE=""
MTP="unknown"  # forwarded as-is to emit-submission.js; pass --mtp on when running an -mtp recipe
PORT=18091  # 8080-8094ish are occupied by other services on this box — see HANDOFF-PLAN.md
RESULTS_FILE="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S).jsonl"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --card) CARD="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --model-name) MODEL_NAME="$2"; shift 2 ;;
    --quantization) QUANTIZATION="$2"; shift 2 ;;
    --concurrency-levels) CONCURRENCY_LEVELS="$2"; shift 2 ;;
    --repeats) REPEATS="$2"; shift 2 ;;
    --max-model-lens) MAX_MODEL_LENS="$2"; shift 2 ;;
    --prefill-lengths) PREFILL_LENGTHS="$2"; shift 2 ;;
    --max-tokens) MAX_TOKENS="$2"; shift 2 ;;
    --num-prompts-per-level) NUM_PROMPTS_PER_LEVEL="$2"; shift 2 ;;
    --resume) RESUME=1; shift ;;
    --recipe) RECIPE="$2"; shift 2 ;;
    --mtp) MTP="$2"; shift 2 ;;
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

# Every flag except the swept context axis comes from a recipe in
# ../../recipes, so a published number is always attributable to a recipe
# someone can copy.
RECIPE="${RECIPE:-vllm-sycl-balanced}"
RECIPE_FILE="$REPO_ROOT/recipes/$RECIPE.sh"
if [[ ! -f "$RECIPE_FILE" ]]; then
  echo "No such recipe: $RECIPE_FILE"
  echo "Available:"; ls "$REPO_ROOT/recipes"/vllm-*.sh | xargs -n1 basename
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

SYSTEM_INFO_FILE="$SCRIPT_DIR/cache/system-info.json"
if [[ ! -f "$SYSTEM_INFO_FILE" ]]; then
  echo "System info not cached yet — running collect-system-info.sh..."
  "$SCRIPT_DIR/collect-system-info.sh" > /dev/null
fi

SERVER_PID=""

# SIGTERM, then wait up to 30s (polling, not a blocking `wait`), then SIGKILL
# if it still hasn't exited. A plain `kill; wait` can hang the whole sweep
# indefinitely if vLLM doesn't respond to SIGTERM promptly (observed on this
# box: a server sat alive with no client running and 25+ minutes of wall
# time elapsed with no progress, at the end of an otherwise-complete
# max-model-len block, until the process was killed by hand -- see
# HANDOFF-PLAN.md). A bounded wait with a kill -9 fallback means a slow
# shutdown costs the sweep 30s once, not the rest of the run.
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
IFS=',' read -ra CTX_LEVELS <<< "$MAX_MODEL_LENS"
IFS=',' read -ra PREFILL_LEVELS <<< "$PREFILL_LENGTHS"

CELLS_RUN=0
CELLS_SKIPPED=0
CELLS_RESUMED=0
SKIP_LOG=()

for MAX_MODEL_LEN in "${CTX_LEVELS[@]}"; do
  # Which prefill levels leave room for the tokens they have to generate?
  # Concurrency doesn't enter into it here — vLLM's KV cache is managed per
  # request against this ceiling, not carved into fixed per-slot shares.
  FEASIBLE=()
  for P in "${PREFILL_LEVELS[@]}"; do
    NEEDED=$(( P + MAX_TOKENS ))
    if (( MAX_MODEL_LEN >= NEEDED )); then
      FEASIBLE+=("$P")
    else
      # One tally unit == one cell, matching run-llamacpp.sh. This prefill
      # level is infeasible at every concurrency level, so that is one skip
      # per level, not one skip for the group.
      CELLS_SKIPPED=$(( CELLS_SKIPPED + ${#LEVELS[@]} ))
      for SKIPPED_N in "${LEVELS[@]}"; do
        SKIP_LOG+=("max-model-len=$MAX_MODEL_LEN concurrency=$SKIPPED_N prefill=$P (needs $NEEDED)")
      done
    fi
  done

  if (( ${#FEASIBLE[@]} == 0 )); then
    echo "=== max-model-len=$MAX_MODEL_LEN — no prefill level fits, not starting a server ==="
    continue
  fi

  FULL_COMMAND_LAUNCH="BENCH_RECIPE=$RECIPE VLLM_MODEL=$MODEL VLLM_PORT=$PORT VLLM_MAX_MODEL_LEN=$MAX_MODEL_LEN $SCRIPT_DIR/vllm-serve-launch.sh"

  echo ""
  echo "Starting vLLM server at max-model-len=$MAX_MODEL_LEN (model load can take a while)..."
  SERVER_LOG=$(mktemp)
  BENCH_RECIPE="$RECIPE" VLLM_MODEL="$MODEL" VLLM_PORT="$PORT" VLLM_MAX_MODEL_LEN="$MAX_MODEL_LEN" \
    "$SCRIPT_DIR/vllm-serve-launch.sh" > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

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
    echo "vLLM server did not become healthy at max-model-len=$MAX_MODEL_LEN — recording every cell at this context level as crashed"
    tail -30 "$SERVER_LOG"
    stop_server "$SERVER_PID"; SERVER_PID=""
    for N in "${LEVELS[@]}"; do
      for P in "${FEASIBLE[@]}"; do
        node "$SCRIPT_DIR/lib/emit-submission.js" \
          --results-file "$RESULTS_FILE" \
          --card "$CARD" --backend SYCL --runtime "vLLM" \
          --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
          --concurrency "$N" --context-length "$MAX_MODEL_LEN" --prompt-tokens "$P" \
          --full-command "$FULL_COMMAND_LAUNCH" \
          --recipe "$RECIPE" --kv-cache-type "$KV_CACHE_TYPE" \
          --runtime-version "$RUNTIME_VERSION" \
          --system-info-file "$SYSTEM_INFO_FILE" \
          --mtp "$MTP" \
          --crashed 1 \
          --stability-notes "vLLM server did not become healthy within 360s at max-model-len=$MAX_MODEL_LEN." \
          --repeats-json '[{"generation_tok_s":null,"prompt_eval_tok_s":null}]'
        CELLS_RUN=$(( CELLS_RUN + 1 ))
      done
    done
    rm -f "$SERVER_LOG"
    continue
  fi

  SERVER_DIED=0
  for N in "${LEVELS[@]}"; do
    (( SERVER_DIED )) && break
    for P in "${FEASIBLE[@]}"; do
      if (( RESUME )) && node "$SCRIPT_DIR/lib/has-cell.js" --file "$RESULTS_FILE" \
           --card "$CARD" --backend SYCL --runtime "vLLM" \
           --model-name "$MODEL_NAME" --context-length "$MAX_MODEL_LEN" \
           --concurrency "$N" --prompt-tokens "$P"; then
        echo "  resume: max-model-len=$MAX_MODEL_LEN concurrency=$N prefill=$P already recorded, skipping"
        CELLS_RESUMED=$(( CELLS_RESUMED + 1 ))
        continue
      fi
      # Fail fast if the server already died mid-block (see the crash-flag
      # fix above for why this matters): without this check every remaining
      # cell at this max-model-len would silently run its full repeat count
      # against a dead server and only get caught by the (now-fixed)
      # requests_completed check, one slow cell at a time.
      if ! curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
        echo "  vLLM server died mid-block (max-model-len=$MAX_MODEL_LEN) — recording remaining cells at this context as crashed, not attempting them"
        node "$SCRIPT_DIR/lib/emit-submission.js" \
          --results-file "$RESULTS_FILE" \
          --card "$CARD" --backend SYCL --runtime "vLLM" \
          --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
          --concurrency "$N" --context-length "$MAX_MODEL_LEN" --prompt-tokens "$P" \
          --full-command "$FULL_COMMAND_LAUNCH" \
          --recipe "$RECIPE" --kv-cache-type "$KV_CACHE_TYPE" \
          --runtime-version "$RUNTIME_VERSION" \
          --system-info-file "$SYSTEM_INFO_FILE" \
          --mtp "$MTP" \
          --crashed 1 \
          --stability-notes "vLLM server died mid-block at max-model-len=$MAX_MODEL_LEN (found dead before this cell started)." \
          --repeats-json '[{"generation_tok_s":null,"prompt_eval_tok_s":null}]'
        CELLS_RUN=$(( CELLS_RUN + 1 ))
        SERVER_DIED=1
        break
      fi
      echo "=== $CARD / SYCL / vLLM @ max-model-len=$MAX_MODEL_LEN, concurrency=$N, prefill=$P ==="
      NUM_PROMPTS="${NUM_PROMPTS_PER_LEVEL:-$((N * 10))}"
      # --dataset-name random is what makes prefill a controlled axis: the
      # default dataset's prompt lengths are whatever the corpus happens to
      # contain, which can't be swept and isn't comparable to the calibrated
      # prompts the llama.cpp side sends.
      BENCH_COMMAND="vllm bench serve --backend vllm --base-url http://localhost:$PORT --model $MODEL --max-concurrency $N --num-prompts $NUM_PROMPTS --dataset-name random --random-input-len $P --random-output-len $MAX_TOKENS"

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

      # Two independent crash signatures, checked separately so the message
      # says which one actually happened: (a) the `vllm bench serve`
      # subprocess itself produced no readable result file (parse-vllm-
      # result.js's 'unreadable' fallback — the tool crashed or never ran),
      # and (b) the tool ran fine and returned valid JSON, but the server
      # was already dead/unresponsive underneath it, so zero requests
      # actually completed (`requests_completed === 0`). (b) was previously
      # unchecked — a cell where every single request failed against a
      # crashed server was silently recorded as crashed=0, because
      # 'unreadable' only covers the client-tool-crashed case, not
      # server-crashed-but-client-ran-fine. Discovered when a vLLM server
      # died partway through its first max-model-len block (2026-09-12) and
      # every subsequent cell in that block kept reporting crashed=0 with
      # generation_tok_s=0 for the rest of the block's lifetime.
      ANY_ZERO_COMPLETED=$(node -e "
        const arr = $REPEATS_JSON;
        console.log(arr.some((r) => r.source === 'unreadable' || !r.requests_completed) ? '1' : '0');
      ")
      CRASHED_FLAG=0
      STABILITY_NOTES=""
      if [[ "$ANY_ZERO_COMPLETED" == "1" ]]; then
        CRASHED_FLAG=1
        STABILITY_NOTES="One or more repeats had zero successful requests or no readable vllm bench serve result at this cell — possible crash/hang mid-run."
      fi

      node "$SCRIPT_DIR/lib/emit-submission.js" \
        --results-file "$RESULTS_FILE" \
        --card "$CARD" --backend SYCL --runtime vLLM \
        --model-name "$MODEL_NAME" --quantization "$QUANTIZATION" \
        --concurrency "$N" --context-length "$MAX_MODEL_LEN" --prompt-tokens "$P" \
        --full-command "$BENCH_COMMAND (server: $FULL_COMMAND_LAUNCH)" \
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
  done

  stop_server "$SERVER_PID"; SERVER_PID=""
  rm -f "$SERVER_LOG"
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
