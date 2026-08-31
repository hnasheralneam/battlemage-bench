You're running on the machine that physically has the Intel Arc GPU(s) —
right now, only a **B70** is installed (no B65 yet). Your job is to run the
Battlemage Benchmarks test matrix for the B70 only, using the tooling in
`scripts/bench/` (already copied onto this machine alongside this prompt),
and hand the results back.

Read `scripts/bench/README.md` first for the full picture. The short version:

- `run-llamacpp.sh` / `run-vllm.sh` each sweep concurrency levels 1,2,4,8,16
  with 3 repeats per level (first repeat discarded as warmup, median
  reported) and append one JSON row per level to a results `.jsonl` file.
- `run-matrix.sh --card B70 ...` runs every applicable cell in one go.
- Nothing auto-detects the GPU or scans for models — you fill in real paths.
- Model/quant is **not** forced to match between llama.cpp and vLLM — pick
  what's actually installed/appropriate for each, and say so honestly.

## Steps

1. **Orient yourself.** Confirm only the B70 is active (`xpu-smi discovery`
   or equivalent). Note the driver/oneAPI/Vulkan versions you find —
   `scripts/bench/collect-system-info.sh` does this automatically and caches
   it, so just run it once and glance at the output.

2. **Locate the two llama.cpp builds.** There should be a Vulkan-backend
   build and a separate SYCL-backend build (two checkouts). Find them and
   either export `LLAMACPP_VULKAN_DIR` / `LLAMACPP_SYCL_DIR` before running
   the scripts, or edit those variables directly at the top of
   `scripts/bench/llama-server-launch.vulkan.sh` /
   `llama-server-launch.sycl.sh`. If you can't find one of the two builds,
   stop and ask the human operator rather than guessing or building one
   yourself.

3. **Fill in `scripts/bench/vllm-serve-launch.sh`.** This file is a
   **placeholder** — it has never been run for real. Find the actual vLLM
   environment (venv/conda/uv — check for something like `~/vllm-xpu` or
   similar, or ask) and set `VLLM_ENV_ACTIVATE`. Check what flags the vLLM
   install actually needs for the XPU device (some versions want
   `--dtype`, `--quantization`, `--gpu-memory-utilization`, etc.) and put
   those in `VLLM_EXTRA_ARGS`. Confirm `vllm serve <model> --device xpu`
   actually starts and serves before trusting it in a long sweep.

4. **Confirm the models.** For llama.cpp, there's likely already a GGUF
   downloaded from the earlier tuning work (check
   `~/.cache/huggingface/hub/` for something like
   `models--unsloth--Qwen3.8-27B-GGUF`) — confirm the exact file and its
   quant (e.g. Q4_K_M) rather than assuming. For vLLM, ask the human
   operator which model/quant to use if it's not obvious — it doesn't need
   to be the same model as the llama.cpp side.

5. **Smoke-test before committing to the full sweep.** Run one cheap cell
   manually first, e.g.:
   ```
   ./run-llamacpp.sh --backend Vulkan --card B70 \
     --model-path <path> --model-name "<name>" --quantization <quant> \
     --concurrency-levels 1 --repeats 1 --duration 10
   ```
   Confirm it produces a sane-looking row (check the printed tok/s isn't
   zero/null and `crashed` is 0) before running the real thing — a broken
   path or wrong flag is much cheaper to catch here than after a 30+ minute
   run.

6. **Run the full B70 sweep:**
   ```
   ./run-matrix.sh --card B70 \
     --llamacpp-model-path <path> --llamacpp-model-name "<name>" --llamacpp-quantization <quant> \
     --vllm-model <path-or-hf-id> --vllm-model-name "<name>" --vllm-quantization <quant> \
     --results-file results/b70-run-1.jsonl
   ```
   This is 3 cells × 5 concurrency levels × 3 repeats — expect it to take a
   while (llama.cpp restarts the server per concurrency level since
   `--parallel` is a startup flag; vLLM only starts once). If a cell's
   server won't come up, the script records it as `crashed=1` and moves on
   rather than hanging — that's fine, it's a real result too.

7. **Hand the results back.** Once done:
   - Print the full contents of `results/b70-run-1.jsonl` to your final
     message, wrapped exactly like this so it's easy to extract:
     ```
     ===BEGIN RESULTS JSONL===
     <full file contents, one JSON object per line>
     ===END RESULTS JSONL===
     ```
   - Also give a short plain-English summary: which cells ran clean, which
     (if any) came back `crashed=1` and why, and the rough tok/s range you
     saw per runtime.
   - **If** you and the human operator know this machine can reach the
     machine hosting the Battlemage Benchmarks site directly over the
     network, you can skip the copy-paste and submit straight to the
     pending queue instead:
     ```
     node submit-jsonl.js --file results/b70-run-1.jsonl --base-url http://<site-host>:3000
     ```
     Otherwise, don't guess at a URL — just print the JSONL as above and
     let the human relay it.

## Guardrails

- Don't modify anything outside `scripts/bench/` — this is a copy of just
  the benchmark tooling, not the live site.
- Don't invent model paths, driver versions, or vLLM flags you haven't
  actually verified on this machine — ask the human operator when unsure.
- Don't try to build llama.cpp or install vLLM from scratch as a
  workaround if something's missing — stop and ask.
