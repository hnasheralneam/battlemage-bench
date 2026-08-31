const db = require('../db');
const {
  FILTERABLE,
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

// Builds a parameterized WHERE clause from a whitelist of query params.
// Returns { where, params } — where is '' or 'WHERE ...'.
function buildFilterClause(filters, extra) {
  const clauses = [];
  const params = {};
  for (const [param, column] of Object.entries(FILTERABLE)) {
    const value = filters[param];
    if (value !== undefined && value !== '') {
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

// Best verified run per card/backend/runtime combo, by generation_tok_s.
function bestPerCombo() {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY card, backend, runtime ORDER BY generation_tok_s DESC
         ) AS rn
         FROM submissions WHERE status = 'verified'
       ) WHERE rn = 1`
    )
    .all();
}

function getVerifiedForCombo(card, backend, runtime) {
  return db
    .prepare(
      `SELECT * FROM submissions
       WHERE status = 'verified' AND card = ? AND backend = ? AND runtime = ?
       ORDER BY context_length ASC, concurrency ASC`
    )
    .all(card, backend, runtime);
}

// Homepage stats strip: total verified submissions and the best efficiency
// (tok/s per watt) seen across them. bestEfficiency is null if no verified
// run has power measured — treat that as "not measured," not zero.
function getStats() {
  const verifiedCount = db
    .prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'verified'")
    .get().n;
  const bestEfficiency = db
    .prepare("SELECT MAX(tok_s_per_watt) AS v FROM submissions WHERE status = 'verified'")
    .get().v;
  return { verifiedCount, bestEfficiency };
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
  getVerifiedForCombo,
  getStats,
};
