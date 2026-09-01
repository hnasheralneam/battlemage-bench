-- Battlemage Benchmarks schema (migration v1)
-- Frozen: this file is migration v1 and must not be edited. Columns added
-- later live as ALTER TABLE steps in the migrations array in src/db.js.

CREATE TABLE IF NOT EXISTS submissions (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- workflow
  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','verified','rejected')),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at                 TEXT,

  -- submitter (optional)
  submitter_name              TEXT,
  submitter_contact           TEXT,

  -- what was tested
  card                        TEXT NOT NULL CHECK (card IN ('B70','B65')),
  backend                     TEXT NOT NULL CHECK (backend IN ('Vulkan','SYCL')),
  runtime                     TEXT NOT NULL CHECK (runtime IN ('llama.cpp','vLLM')),
  model_name                  TEXT NOT NULL,
  quantization                TEXT NOT NULL,
  concurrency                 INTEGER NOT NULL DEFAULT 1,
  context_length               INTEGER NOT NULL,

  -- flags
  flash_attention              TEXT DEFAULT 'unknown' CHECK (flash_attention IN ('on','off','unknown')),
  mtp                          TEXT DEFAULT 'unknown' CHECK (mtp IN ('on','off','unknown')),
  tensor_split                 TEXT,
  full_command                 TEXT NOT NULL,

  -- software / system versions
  os_name                      TEXT,
  kernel_version               TEXT,
  gpu_driver_version           TEXT,
  sdk_version                  TEXT,   -- oneAPI or Vulkan SDK version
  runtime_version               TEXT,   -- llama.cpp/vLLM version or commit

  -- power / memory
  power_limit_watts             REAL,
  measured_power_draw_watts      REAL,
  vram_used_mb                    INTEGER,

  -- results
  prompt_eval_tok_s                REAL,
  generation_tok_s                  REAL NOT NULL,
  tok_s_per_watt REAL GENERATED ALWAYS AS
    (generation_tok_s / NULLIF(measured_power_draw_watts, 0)) STORED,

  -- stability / logs / free text
  crashed                      INTEGER NOT NULL DEFAULT 0 CHECK (crashed IN (0,1)),
  stability_notes              TEXT,
  raw_log                      TEXT,
  notes                        TEXT,

  -- internal, never shown publicly
  admin_notes                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_combo  ON submissions(card, backend, runtime, status);
