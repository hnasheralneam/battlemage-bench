const db = require('../db');
const {
  FILTERABLE,
  REFERENCE_CELL,
  LIKE_FILTERS,
  SORTABLE,
  SUBMISSION_INPUT_COLUMNS,
  ADMIN_EDITABLE_COLUMNS,
} = require('./constants');

function insertSubmission(data) {
  const columns = SUBMISSION_INPUT_COLUMNS;
  const placeholders = columns.map((c) => `@${c}`).join(', ');
  const stmt = db.prepare(
    `INSERT INTO submissions (${columns.join(', ')}) VALUES (${placeholders})`
  );
  const params = {};
  for (const col of columns) {
    params[col] = data[col] === undefined ? null : data[col];
  }
  const info = stmt.run(params);
  return info.lastInsertRowid;
}

function updateSubmission(id, data) {
  const columns = ADMIN_EDITABLE_COLUMNS.filter((c) => data[c] !== undefined);
  if (columns.length === 0) return;
  const setClause = columns.map((c) => `${c} = @${c}`).join(', ');
  const stmt = db.prepare(
    `UPDATE submissions SET ${setClause}, updated_at = datetime('now') WHERE id = @id`
  );
  const params = { id };
  for (const col of columns) params[col] = data[col];
  stmt.run(params);
}

function setStatus(id, status) {
  if (status === 'verified') {
    db.prepare(
      `UPDATE submissions
       SET status = 'verified', verified_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(id);
  } else {
    db.prepare(
      `UPDATE submissions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, id);
  }
}

function getById(id) {
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
}

function getPending() {
  return db
    .prepare("SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at ASC")
    .all();
}

// LIKE reads % and _ as wildcards, so an unescaped literal like "Q4_K_M"
// would match any character where its underscores are. Escape those and the
// escape character itself; every LIKE below pairs with ESCAPE '\\'.
function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

// Builds a parameterized WHERE clause from a whitelist of query params.
// Returns { where, params } — where is '' or 'WHERE ...'. Values are always
// bound as SQL parameters; only the column names come from the whitelist.
function buildFilterClause(filters, extra) {
  const clauses = [];
  const params = {};
  for (const [param, column] of Object.entries(FILTERABLE)) {
    const value = filters[param];
    if (value === undefined || value === '') continue;
    switch (LIKE_FILTERS[param]) {
      case 'prefix':
        clauses.push(`${column} LIKE @${param} || '%' ESCAPE '\\'`);
        params[param] = likeEscape(value);
        break;
      case 'substring':
        clauses.push(`${column} LIKE '%' || @${param} || '%' ESCAPE '\\'`);
        params[param] = likeEscape(value);
        break;
      default:
        clauses.push(`${column} = @${param}`);
        params[param] = value;
    }
  }
  if (extra) clauses.push(extra);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

function getVerified(filters = {}) {
  const { where, params } = buildFilterClause(filters, "status = 'verified'");

  let sort = SORTABLE.includes(filters.sort) ? filters.sort : 'created_at';
  let dir = filters.dir === 'asc' ? 'ASC' : 'DESC';

  const stmt = db.prepare(
    `SELECT * FROM submissions ${where} ORDER BY ${sort} ${dir}`
  );
  return stmt.all(params);
}

// Best verified run per card/backend/runtime combo.
//
// Ranking purely by generation_tok_s across every cell would always surface
// the smallest model at the highest concurrency, so the six configurations
// would be compared at six different workloads. Rows at REFERENCE_CELL win
// first, and throughput only breaks ties within that — but a combo with no
// reference-cell row still returns its best row rather than vanishing from
// the homepage, since an unrepresentative number is more useful here than a
// gap. The row carries model_name so the view can say which model it was.
//
// Crashed rows are excluded outright: they measured nothing (generation_tok_s
// is null for them), and "best" should never be a run that fell over.
function bestPerCombo() {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY card, backend, runtime
           ORDER BY
             (concurrency = @refConcurrency) DESC,
             (prompt_tokens = @refPromptTokens) DESC,
             generation_tok_s DESC
         ) AS rn
         FROM submissions
         WHERE status = 'verified' AND crashed = 0 AND generation_tok_s IS NOT NULL
       ) WHERE rn = 1`
    )
    .all({
      refConcurrency: REFERENCE_CELL.concurrency,
      refPromptTokens: REFERENCE_CELL.prompt_tokens,
    });
}

function getVerifiedForCombo(card, backend, runtime) {
  return db
    .prepare(
      `SELECT * FROM submissions
       WHERE status = 'verified' AND card = ? AND backend = ? AND runtime = ?
       ORDER BY context_length ASC, prompt_tokens ASC, concurrency ASC`
    )
    .all(card, backend, runtime);
}

// Best verified run per (workload, backend), where "workload" is everything
// that has to match for two runs to be worth comparing. ROW_NUMBER rather
// than MAX(generation_tok_s) so every metric on a side comes from one real
// run instead of being mixed across rows.
//
// runtime is part of the key deliberately: vLLM has no Vulkan backend on
// Intel, so pairing across runtimes would compare two different artifacts
// and call the difference a backend one. prompt_tokens is compared with IS,
// not =, because it is nullable and NULL = NULL is never true in SQL.
const WORKLOAD_KEY = [
  'card',
  'runtime',
  'model_name',
  'quantization',
  'concurrency',
  'context_length',
  'prompt_tokens',
];

function backendComparison() {
  const partition = WORKLOAD_KEY.join(', ');
  const joinOn = WORKLOAD_KEY.map((c) =>
    c === 'prompt_tokens' ? `v.${c} IS s.${c}` : `v.${c} = s.${c}`
  ).join(' AND ');

  return db
    .prepare(
      `WITH best AS (
         SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY ${partition}, backend ORDER BY generation_tok_s DESC
           ) AS rn
           FROM submissions WHERE status = 'verified'
         ) WHERE rn = 1
       )
       SELECT
         v.card, v.runtime, v.model_name, v.quantization,
         v.concurrency, v.context_length, v.prompt_tokens,
         v.generation_tok_s  AS vulkan_gen,
         s.generation_tok_s  AS sycl_gen,
         v.prompt_eval_tok_s AS vulkan_prompt_eval,
         s.prompt_eval_tok_s AS sycl_prompt_eval,
         v.crashed           AS vulkan_crashed,
         s.crashed           AS sycl_crashed
       FROM best v
       JOIN best s ON ${joinOn}
       WHERE v.backend = 'Vulkan' AND s.backend = 'SYCL'
       ORDER BY s.generation_tok_s - v.generation_tok_s DESC`
    )
    .all();
}

// Verified runs that crashed. Published rather than dropped: for someone
// deciding what to install, a combination that falls over is more useful
// than another throughput number.
function knownBadRuns() {
  return db
    .prepare(
      `SELECT card, backend, runtime, model_name, quantization,
              concurrency, context_length,
              kernel_version, gpu_driver_version, sdk_version, runtime_version,
              stability_notes,
              COALESCE(verified_at, created_at) AS observed_at
       FROM submissions
       WHERE status = 'verified' AND crashed = 1
       ORDER BY observed_at DESC`
    )
    .all();
}

// Site-wide stats: the homepage strip and the footer freshness stamp both
// read from this. bestEfficiency is null if no verified run has power
// measured — treat that as "not measured," not zero. lastVerifiedAt is null
// until something is published, which is a state every page has to render.
function getStats() {
  const verifiedCount = db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'verified'")
    .get().n;
  const bestEfficiency = db
    .prepare("SELECT MAX(tok_s_per_watt) AS v FROM submissions WHERE status = 'verified'")
    .get().v;
  // Rows verified before verified_at was recorded fall back to created_at,
  // so the stamp never reads as older than the data actually is.
  const lastVerifiedAt = db
    .prepare(
      `SELECT MAX(COALESCE(verified_at, created_at)) AS v
       FROM submissions WHERE status = 'verified'`
    )
    .get().v;
  return { verifiedCount, bestEfficiency, lastVerifiedAt };
}

module.exports = {
  SUBMISSION_INPUT_COLUMNS,
  ADMIN_EDITABLE_COLUMNS,
  insertSubmission,
  updateSubmission,
  setStatus,
  getById,
  getPending,
  getVerified,
  bestPerCombo,
  backendComparison,
  knownBadRuns,
  getVerifiedForCombo,
  getStats,
};
