// Dev/demo seed data: verified rows spanning all 8 card×backend×runtime
// combos with varying context_length/concurrency/quantization, plus a few
// pending rows to exercise the submission/admin flow.
//
// Run with: npm run seed

const db = require('./db');
const { insertSubmission, setStatus } = require('./lib/queries');
const { CARDS, BACKENDS, RUNTIMES } = require('./lib/constants');

db.exec('DELETE FROM submissions');

const CONTEXT_LENGTHS = [2048, 8192, 32768];

function baseRun(card, backend, runtime, contextLength, concurrency) {
  // Rough synthetic numbers just for exercising the UI — not real benchmark data.
  const cardFactor = card === 'B70' ? 1.35 : 1.0;
  const backendFactor = backend === 'SYCL' ? 1.15 : 1.0;
  const runtimeFactor = runtime === 'vLLM' ? 0.9 + concurrency * 0.35 : 1.0;
  const contextPenalty = 1 - (contextLength / 32768) * 0.4;
  const genTokS = Math.round(
    60 * cardFactor * backendFactor * runtimeFactor * contextPenalty * 10
  ) / 10;
  const promptEvalTokS = Math.round(genTokS * 6.5 * 10) / 10;
  const powerDraw = card === 'B70' ? 190 : 140;

  return {
    submitter_name: 'Seed Data',
    submitter_contact: null,
    card,
    backend,
    runtime,
    model_name: 'Llama-3.1-8B-Instruct',
    quantization: 'Q4_K_M',
    concurrency,
    context_length: contextLength,
    flash_attention: 'on',
    mtp: 'unknown',
    tensor_split: null,
    full_command:
      runtime === 'llama.cpp'
        ? `./llama-server -m llama-3.1-8b-instruct-q4_k_m.gguf --ctx-size ${contextLength} -ngl 999 -fa`
        : `vllm serve meta-llama/Llama-3.1-8B-Instruct --quantization awq --max-model-len ${contextLength} --max-num-seqs ${concurrency}`,
    os_name: 'Ubuntu 24.04 LTS',
    kernel_version: '6.11.0-9-generic',
    gpu_driver_version: '24.35.30872.22',
    sdk_version: backend === 'SYCL' ? '2024.2.1' : '1.3.290',
    runtime_version: runtime === 'llama.cpp' ? 'b3600' : '0.6.1',
    power_limit_watts: powerDraw + 10,
    measured_power_draw_watts: powerDraw,
    vram_used_mb: card === 'B70' ? 14200 : 9800,
    prompt_eval_tok_s: promptEvalTokS,
    generation_tok_s: genTokS,
    crashed: 0,
    stability_notes: null,
    raw_log: `[seed data placeholder log for ${card}/${backend}/${runtime} @ ctx=${contextLength}, concurrency=${concurrency}]`,
    notes: 'Synthetic seed row for local development — not a real benchmark result.',
  };
}

let verifiedCount = 0;
for (const card of CARDS) {
  for (const backend of BACKENDS) {
    for (const runtime of RUNTIMES) {
      for (const contextLength of CONTEXT_LENGTHS) {
        const concurrency = runtime === 'vLLM' ? 4 : 1;
        const id = insertSubmission(baseRun(card, backend, runtime, contextLength, concurrency));
        setStatus(id, 'verified');
        verifiedCount += 1;
      }
    }
  }
}

// A couple of pending rows to exercise /submit -> /admin.
const pendingRows = [
  {
    ...baseRun('B70', 'Vulkan', 'llama.cpp', 4096, 1),
    submitter_name: 'Anonymous',
    notes: 'Pending seed row — awaiting admin review.',
  },
  {
    ...baseRun('B65', 'SYCL', 'vLLM', 8192, 8),
    submitter_name: 'Anonymous',
    notes: 'Pending seed row — awaiting admin review.',
  },
];
for (const row of pendingRows) {
  insertSubmission(row); // stays 'pending' (default)
}

console.log(`Seeded ${verifiedCount} verified rows and ${pendingRows.length} pending rows.`);
