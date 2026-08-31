#!/usr/bin/env node
// Reads a JSONL file of submission-ready rows (as produced by
// emit-submission.js) and POSTs each one to the site's public POST /submit
// endpoint as ordinary form data — reusing the existing validation and
// pending-queue workflow untouched. Every row still needs manual approval
// via /admin, exactly like a submission made through the web form.
//
// Usage:
//   node submit-jsonl.js --file results/2026-xxx.jsonl \
//     [--base-url http://localhost:3000] [--dry-run]

const fs = require('node:fs');
const { parseArgs } = require('node:util');

function parseArgv() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      'base-url': { type: 'string', default: 'http://localhost:3000' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.file) {
    console.error(
      'Usage: node submit-jsonl.js --file <path.jsonl> [--base-url <url>] [--dry-run]'
    );
    process.exit(1);
  }
  return values;
}

function toFormBody(row) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (key === 'crashed') {
      // Matches the HTML checkbox's own wire format: present as "on" when
      // checked, omitted entirely when not — validate.js's crashed check is
      // written against that shape, not a bare "1"/"0" string.
      if (value === 1 || value === true) params.set('crashed', 'on');
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

async function main() {
  const { file, 'base-url': baseUrl, 'dry-run': dryRun } = parseArgv();
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let ok = 0;
  let failed = 0;

  for (const [i, line] of lines.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      console.error(`line ${i + 1}: invalid JSON, skipping (${err.message})`);
      failed += 1;
      continue;
    }

    const label = `${row.card}/${row.backend}/${row.runtime} @ concurrency=${row.concurrency}`;

    if (dryRun) {
      console.log(`[dry-run] would submit line ${i + 1}: ${label}`);
      ok += 1;
      continue;
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toFormBody(row).toString(),
      redirect: 'manual', // a successful submit 302s to /submit/thanks; no need to follow it
    });

    if (res.status === 302) {
      console.log(`line ${i + 1}: submitted (${label})`);
      ok += 1;
    } else {
      console.error(`line ${i + 1}: submit failed with status ${res.status} (${label})`);
      failed += 1;
    }
  }

  console.log(`\n${ok} submitted, ${failed} failed, out of ${lines.length} total.`);
  if (failed > 0) process.exit(1);
}

main();
