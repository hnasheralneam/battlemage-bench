#!/usr/bin/env node
// Prints a compact per-file summary of one or more results JSONL files:
// row count, crashed count, and generation_tok_s range per
// runtime/backend/card combo. Meant to run once at the end of a sweep so the
// agent has a plain-English readout to pair with the raw JSONL, per
// REMOTE_AGENT_PROMPT.md's "handing the results back" section.
//
// Usage: node summarize-results.js --file results/a.jsonl --file results/b.jsonl

const fs = require('node:fs');
const { parseArgs } = require('node:util');

function loadRows(file) {
  if (!fs.existsSync(file)) return null;
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function summarizeFile(file) {
  const rows = loadRows(file);
  console.log(`\n--- ${file} ---`);
  if (rows === null) {
    console.log('  (file not found — no cells ran, or run-matrix.sh never got here)');
    return;
  }
  if (rows.length === 0) {
    console.log('  (empty — no cells ran)');
    return;
  }

  const crashed = rows.filter((r) => r.crashed === 1);
  console.log(`  ${rows.length} rows, ${crashed.length} crashed`);

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.card}/${r.backend}/${r.runtime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const [key, group] of [...groups.entries()].sort()) {
    const ok = group.filter((r) => r.crashed !== 1 && typeof r.generation_tok_s === 'number');
    const crashedInGroup = group.length - ok.length;
    if (ok.length === 0) {
      console.log(`  ${key}: ${group.length} cells, all crashed/unmeasured`);
      continue;
    }
    const values = ok.map((r) => r.generation_tok_s);
    const min = Math.min(...values).toFixed(1);
    const max = Math.max(...values).toFixed(1);
    console.log(
      `  ${key}: ${group.length} cells (${crashedInGroup} crashed) — generation_tok_s ${min}–${max}`
    );
  }
}

function main() {
  const { values } = parseArgs({
    options: { file: { type: 'string', multiple: true } },
  });
  const files = values.file || [];
  if (files.length === 0) {
    console.error('Usage: node summarize-results.js --file <path> [--file <path> ...]');
    process.exit(1);
  }
  for (const file of files) summarizeFile(file);
}

main();
