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
