const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ordered migrations, applied via PRAGMA user_version. Each entry's `up`
// brings the DB from (version - 1) to `version`. Add new steps here as the
// schema evolves — never edit an already-shipped step.
const migrations = [
  {
    version: 1,
    up: () => {
      const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      db.exec(schemaSql);
    },
  },
  {
    version: 2,
    up: () => {
      // Prefill length (prompt tokens per request) — the benchmark sweep's
      // second axis alongside context_length. Nullable: rows submitted
      // before the prefill axis existed, and hand submissions that didn't
      // control prompt length, legitimately have no value here.
      db.exec('ALTER TABLE submissions ADD COLUMN prompt_tokens INTEGER');
    },
  },
  {
    version: 3,
    up: () => {
      // generation_tok_s becomes nullable, so a crashed run can record that it
      // measured nothing. It previously had to carry a number, and the bench
      // runner supplied 0 — which renders in /results as a legitimate-looking
      // 0.0 tok/s and drags down charts and the homepage best-of ranking.
      //
      // SQLite can't drop a NOT NULL in place, so this is the standard
      // rebuild-and-rename. tok_s_per_watt is GENERATED ... STORED and so is
      // excluded from the copy — SQLite recomputes it. The new CHECK keeps
      // the invariant the NOT NULL used to imply: only a crashed row may have
      // no throughput number.
      db.exec(`
        CREATE TABLE submissions_new (
          id                          INTEGER PRIMARY KEY AUTOINCREMENT,
          status                      TEXT NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending','verified','rejected')),
          created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
          verified_at                 TEXT,
          submitter_name              TEXT,
          submitter_contact           TEXT,
          card                        TEXT NOT NULL CHECK (card IN ('B70','B65')),
          backend                     TEXT NOT NULL CHECK (backend IN ('Vulkan','SYCL')),
          runtime                     TEXT NOT NULL CHECK (runtime IN ('llama.cpp','vLLM')),
          model_name                  TEXT NOT NULL,
          quantization                TEXT NOT NULL,
          concurrency                 INTEGER NOT NULL DEFAULT 1,
          context_length              INTEGER NOT NULL,
          prompt_tokens               INTEGER,
          flash_attention             TEXT DEFAULT 'unknown' CHECK (flash_attention IN ('on','off','unknown')),
          mtp                         TEXT DEFAULT 'unknown' CHECK (mtp IN ('on','off','unknown')),
          tensor_split                TEXT,
          full_command                TEXT NOT NULL,
          os_name                     TEXT,
          kernel_version              TEXT,
          gpu_driver_version          TEXT,
          sdk_version                 TEXT,
          runtime_version             TEXT,
          power_limit_watts           REAL,
          measured_power_draw_watts   REAL,
          vram_used_mb                INTEGER,
          prompt_eval_tok_s           REAL,
          generation_tok_s            REAL,
          tok_s_per_watt REAL GENERATED ALWAYS AS
            (generation_tok_s / NULLIF(measured_power_draw_watts, 0)) STORED,
          crashed                     INTEGER NOT NULL DEFAULT 0 CHECK (crashed IN (0,1)),
          stability_notes             TEXT,
          raw_log                     TEXT,
          notes                       TEXT,
          admin_notes                 TEXT,
          CHECK (generation_tok_s IS NOT NULL OR crashed = 1)
        );

        INSERT INTO submissions_new (
          id, status, created_at, updated_at, verified_at,
          submitter_name, submitter_contact,
          card, backend, runtime, model_name, quantization,
          concurrency, context_length, prompt_tokens,
          flash_attention, mtp, tensor_split, full_command,
          os_name, kernel_version, gpu_driver_version, sdk_version, runtime_version,
          power_limit_watts, measured_power_draw_watts, vram_used_mb,
          prompt_eval_tok_s, generation_tok_s,
          crashed, stability_notes, raw_log, notes, admin_notes
        )
        SELECT
          id, status, created_at, updated_at, verified_at,
          submitter_name, submitter_contact,
          card, backend, runtime, model_name, quantization,
          concurrency, context_length, prompt_tokens,
          flash_attention, mtp, tensor_split, full_command,
          os_name, kernel_version, gpu_driver_version, sdk_version, runtime_version,
          power_limit_watts, measured_power_draw_watts, vram_used_mb,
          prompt_eval_tok_s,
          -- Existing crashed rows carrying the old placeholder 0 become null.
          CASE WHEN crashed = 1 AND generation_tok_s = 0 THEN NULL ELSE generation_tok_s END,
          crashed, stability_notes, raw_log, notes, admin_notes
        FROM submissions;

        DROP TABLE submissions;
        ALTER TABLE submissions_new RENAME TO submissions;

        CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
        CREATE INDEX IF NOT EXISTS idx_submissions_combo  ON submissions(card, backend, runtime, status);
      `);
    },
  },
  {
    version: 4,
    up: () => {
      // `recipe` names the launch recipe that produced the row — the link
      // between a published number and the script someone can copy, which is
      // what the recipes pages are built on. Nullable: hand submissions and
      // every row predating the recipes don't have one.
      db.exec('ALTER TABLE submissions ADD COLUMN recipe TEXT');
      // KV cache precision and mode (e.g. "q8_0/q4_1 unified"). Previously
      // implicit in full_command on the llama.cpp side and absent entirely on
      // the vLLM side, which made cross-runtime rows differ by KV precision
      // with nothing on the row to say so.
      db.exec('ALTER TABLE submissions ADD COLUMN kv_cache_type TEXT');
    },
  },
];

function migrate() {
  const currentVersion = db.pragma('user_version', { simple: true });
  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    });
    applyMigration();
    // eslint-disable-next-line no-console
    console.log(`Applied migration v${migration.version}`);
  }
}

migrate();

module.exports = db;
