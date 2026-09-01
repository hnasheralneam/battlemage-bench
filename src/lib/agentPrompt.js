// The copyable prompt shown on /submit for the user to hand to their own AI
// coding agent. Field names in the JSON schema below must stay in sync with
// SUBMISSION_INPUT_COLUMNS in ./constants.js.
//
// Written to make the agent *detect* rather than interrogate: the previous
// version asked the user for nine things a shell command answers, which made
// submitting tedious and the answers less reliable than the machine's own.
// Questions are reserved for what genuinely can't be detected — which physical
// card was active, what the power meter said, and who gets the credit.

const AGENT_PROMPT = `You are helping a user submit a GPU benchmark result to Battlemage Benchmarks,
a site comparing Intel Arc B70/B65 GPUs across Vulkan/SYCL backends and
llama.cpp/vLLM inference runtimes.

Your job: inspect this system and the benchmark run described below, then
output a single JSON object with EXACTLY the fields listed at the end, using
EXACTLY those field names. Do not add extra fields.

Two rules that matter more than completeness:

1. USE null RATHER THAN GUESSING. A field left null reads as "not measured" on
   the site and costs nothing. A guessed value is indistinguishable from a
   measured one and quietly corrupts a public dataset. If you cannot determine
   something, null is the correct answer, not an estimate.
2. THE TWO THROUGHPUT NUMBERS MEAN SPECIFIC THINGS. See step 4. If the
   benchmark output does not report the quantity described there, emit null for
   that field rather than substituting a different number that happens to be
   labelled "tok/s".

--- Step 1: what was tested (ask the user) ---

Ask which GPU card was used: exactly "B70" or "B65". This CANNOT be detected
reliably — \`xpu-smi discovery\` shows what is installed, not which card served
this particular run — so it must be confirmed by the person who ran it, even if
only one card appears to be present.

Ask which backend: "Vulkan" or "SYCL". Ask which runtime: "llama.cpp" or "vLLM".
Both are usually obvious from the command line in step 3 — if so, state what you
inferred and ask them to confirm rather than asking cold.

--- Step 2: system and software versions (detect these yourself) ---

Run these and use what they report. Do not ask the user for any of them.

  os_name             cat /etc/os-release        (the PRETTY_NAME value)
  kernel_version      uname -r
  gpu_driver_version  xpu-smi discovery, or: dpkg -l | grep -i level-zero
                      or: rpm -qa | grep -i level-zero
  sdk_version         SYCL:   cat /opt/intel/oneapi/version.txt, or sycl-ls
                      Vulkan: vulkaninfo --summary | grep -i "Vulkan Instance Version"
  runtime_version     llama.cpp: the binary's --version output, or
                                 git -C <checkout> rev-parse --short HEAD
                      vLLM:      python -c "import vllm; print(vllm.__version__)"

--- Step 3: the command that was run ---

Get the exact command line, verbatim, as full_command. Check shell history if
the user doesn't have it to hand. Include both the server launch and the
benchmark/load command if they were separate — the server's flags are most of
what determines the numbers.

From that command line, read off (do not ask, and do not assume defaults):

  quantization     e.g. "Q4_K_M", "AWQ-4bit", "FP8" — from the model file name
                   or the runtime's quantization flag
  context_length   llama.cpp --ctx-size, vLLM --max-model-len
  concurrency      llama.cpp --parallel, vLLM --max-concurrency
  flash_attention  llama.cpp --flash-attn; "unknown" if not visible
  mtp              multi-token prediction, if applicable; "unknown" otherwise
  tensor_split     e.g. "0.5,0.5", or null if unused
  kv_cache_type    KV cache precision AND mode, read off the actual flags:
                   llama.cpp -ctk/-ctv give precision (e.g. "q8_0/q4_1"), and
                   -kvu means a unified cache — so "q8_0/q4_1 unified". vLLM:
                   --kv-cache-dtype, e.g. "fp8 paged". null if you can't tell.
  recipe           If and only if the run used one of the site's recipe scripts
                   from recipes/ UNMODIFIED, its name (e.g.
                   "llamacpp-sycl-balanced"). An edited recipe is the user's own
                   configuration — use null. Do not infer a recipe from
                   similar-looking flags.

--- Step 4: the results (the part most often got wrong) ---

  generation_tok_s
    AGGREGATE decode throughput: total output tokens produced, divided by the
    WALL-CLOCK duration of the load, summed across every parallel session.
    At concurrency 1 there is no ambiguity. Above concurrency 1 there is:
      - vLLM's \`output_throughput\` from \`vllm bench serve\` IS this. Use it.
      - llama-server's /metrics ratio tokens_predicted_total /
        tokens_predicted_seconds_total is NOT this — that seconds counter sums
        per-slot time, which overlaps in wall time, so the ratio is a mean
        per-slot rate. Compute total tokens over wall seconds instead.
      - A single-request timing multiplied up is NOT this either.
    Required, UNLESS the run crashed — see step 6.

  prompt_eval_tok_s
    Prefill throughput: prompt tokens processed per second of PREFILL time.
    Not per second of total benchmark time — that includes decode, so the value
    would sink as output length rose.
      - llama-server /metrics: prompt_tokens_total / prompt_seconds_total.
      - vLLM: derive from mean TTFT — mean prompt tokens divided by mean TTFT
        in seconds. (Under concurrency this includes queue wait and so slightly
        understates prefill speed; that is expected and is the safe direction.)
      - vLLM's \`input_throughput\` is NOT this. Do not use it.
    null if the run reports neither.

  prompt_tokens
    Prefill length: prompt tokens per request, as MEASURED, not as requested.
    null if prompt length wasn't controlled.

--- Step 5: power and memory (ask, then take null for an answer) ---

Ask whether GPU power was capped (power_limit_watts) and whether draw was
measured during the run (measured_power_draw_watts), and for peak VRAM used in
MB (vram_used_mb).

If power was measured, ask HOW, and put the method in notes. The site's own
figures are the mean board draw over the load window from
\`xpu-smi dump -d <device> -m 1\`, with no idle baseline subtracted. A figure
measured differently is still useful, but only if the difference is recorded.

Any of these not actually measured: null. Not zero, and not an estimate from
the card's TDP.

--- Step 6: stability ---

Ask whether the run crashed or was unstable. Set crashed true or false, and put
details in stability_notes (OOM, driver reset, garbled or repeated output,
required kernel flags, anything that needed a retry).

A crashed run is worth submitting — a configuration that falls over is a
result. If crashed is true, set generation_tok_s to null rather than 0: zero
would publish as a real measurement of a very slow configuration.

--- Step 7: logs and attribution ---

Capture the full raw console output of the benchmark run, verbatim and
unmodified, as raw_log. Ask for the user's name/handle and optional contact for
attribution — "Anonymous" for submitter_name if they decline, null for
submitter_contact. Put anything else useful in notes.

--- Output ---

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
  "prompt_tokens": integer | null,
  "flash_attention": "on" | "off" | "unknown",
  "mtp": "on" | "off" | "unknown",
  "tensor_split": string | null,
  "kv_cache_type": string | null,
  "recipe": string | null,
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
  "generation_tok_s": number | null,
  "stability_notes": string | null,
  "crashed": boolean,
  "raw_log": string,
  "notes": string | null
}

model_name is free text — any model is welcome. The three the site sweeps are
"Qwen3.8-27B" (27B dense), "Qwen3.6-35B-A3B" (35B MoE, ~3B active) and
"Muse-Glimmer-30B" (30B dense); use those exact spellings if the run used one
of them, so it groups with the existing data.

After producing the JSON, tell the user to copy it and paste it into the
"Paste from agent" box on the Battlemage Benchmarks submit page.`;

// The prompt's JSON schema and the DB's submittable columns have to agree, or
// an agent following this prompt produces a submission the form rejects — and
// nothing else would catch the drift, since the prompt is just a string. Same
// guard as the row-shape assertion in scripts/bench/lib/emit-submission.js.
const { SUBMISSION_INPUT_COLUMNS } = require('./constants');
(function assertSchemaMatchesColumns() {
  const schema = AGENT_PROMPT.slice(
    AGENT_PROMPT.lastIndexOf('{'),
    AGENT_PROMPT.lastIndexOf('}') + 1
  );
  const keys = [...schema.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
  const missing = SUBMISSION_INPUT_COLUMNS.filter((c) => !keys.includes(c));
  const extra = keys.filter((k) => !SUBMISSION_INPUT_COLUMNS.includes(k));
  if (missing.length || extra.length) {
    throw new Error(
      'AGENT_PROMPT JSON schema is out of sync with SUBMISSION_INPUT_COLUMNS.' +
        (missing.length ? `\n  missing from prompt: ${missing.join(', ')}` : '') +
        (extra.length ? `\n  not a real column: ${extra.join(', ')}` : '')
    );
  }
})();

module.exports = { AGENT_PROMPT };
