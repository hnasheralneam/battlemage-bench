// The copyable prompt shown on /submit for the user to hand to their own AI
// coding agent. Field names in the JSON schema below must stay in sync with
// SUBMISSION_INPUT_COLUMNS in ./queries.js.

const AGENT_PROMPT = `You are helping a user submit a GPU benchmark result to the Battlemage Benchmarks
website (a site comparing Intel Arc B70/B65 GPUs across Vulkan/SYCL backends and
llama.cpp/vLLM inference runtimes).

Your job: inspect this system and the benchmark run described below, then output
a single JSON object with EXACTLY the fields listed, using EXACTLY these field
names. Do not add extra fields. Use null for anything you cannot determine —
do not guess or invent values.

Steps:
1. Ask the user (if not obvious) which GPU card was used: must be exactly "B70"
   or "B65". Ask which backend was used: "Vulkan" or "SYCL". Ask which runtime
   was used: "llama.cpp" or "vLLM".
2. Gather system/software info:
   - OS name: \`cat /etc/os-release\` (use the PRETTY_NAME value)
   - Kernel version: \`uname -r\`
   - GPU driver version: check the Intel compute-runtime / level-zero package,
     e.g. \`dpkg -l | grep -i level-zero\` or \`xpu-smi discovery\`
   - SDK version: if backend is SYCL, run \`sycl-ls\` and check the oneAPI basekit
     version (e.g. \`cat /opt/intel/oneapi/version.txt\`); if backend is Vulkan,
     run \`vulkaninfo --summary | grep -i "Vulkan Instance Version"\`
   - Runtime version: for llama.cpp, run the binary with \`--version\` or
     \`git -C <llama.cpp checkout> rev-parse --short HEAD\`; for vLLM, run
     \`python -c "import vllm; print(vllm.__version__)"\`
3. Ask the user for (or find in shell history) the exact command line used to
   launch the benchmark, and capture it verbatim as full_command.
4. Parse the benchmark's own output for prompt_eval_tok_s (prefill tokens/sec)
   and generation_tok_s (decode tokens/sec). If only one combined tok/s number
   is reported, put it in generation_tok_s and leave prompt_eval_tok_s null.
5. Ask the user for (or infer from the command/config): model_name (e.g.
   "Llama-3.1-8B-Instruct"), quantization (e.g. "Q4_K_M", "AWQ-4bit"),
   concurrency (integer, parallel sessions/requests, default 1), context_length
   (integer, context window used for the test), flash_attention ("on"/"off"/
   "unknown"), mtp ("on"/"off"/"unknown" — multi-token prediction, if
   applicable), tensor_split (string like "0.5,0.5", or null if not used).
6. Ask whether GPU power was capped (power_limit_watts) and/or measured during
   the run (measured_power_draw_watts); ask for peak VRAM used in MB
   (vram_used_mb). Use null for any not measured.
7. Ask whether the run crashed or was unstable in any way. Set crashed to true
   or false, and put any details (OOM, driver reset, garbled output, etc.) in
   stability_notes.
8. Capture the full raw console output/log of the benchmark run, verbatim and
   unmodified, as raw_log.
9. Ask for the user's name/handle and optional contact info for attribution.
   Use "Anonymous" for submitter_name if they decline, and null for
   submitter_contact if not given.
10. Put any other useful context in notes.

Output ONLY a single JSON object — no markdown code fences, no commentary
before or after — with exactly these keys:

{
  "submitter_name": string | null,
  "submitter_contact": string | null,
  "card": "B70" | "B65",
  "backend": "Vulkan" | "SYCL",
  "runtime": "llama.cpp" | "vLLM",
  "model_name": string,
  "quantization": string,
  "concurrency": integer,
  "context_length": integer,
  "flash_attention": "on" | "off" | "unknown",
  "mtp": "on" | "off" | "unknown",
  "tensor_split": string | null,
  "full_command": string,
  "os_name": string | null,
  "kernel_version": string | null,
  "gpu_driver_version": string | null,
  "sdk_version": string | null,
  "runtime_version": string | null,
  "power_limit_watts": number | null,
  "measured_power_draw_watts": number | null,
  "vram_used_mb": integer | null,
  "prompt_eval_tok_s": number | null,
  "generation_tok_s": number,
  "stability_notes": string | null,
  "crashed": boolean,
  "raw_log": string,
  "notes": string | null
}

After producing the JSON, tell the user to copy it and paste it into the
"Paste from agent" box on the Battlemage Benchmarks submit page.`;

module.exports = { AGENT_PROMPT };
