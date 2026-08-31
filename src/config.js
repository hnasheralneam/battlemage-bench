require('dotenv').config();
const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  dbPath: process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'battlemage.db'),
};

if (config.isProduction && !config.adminPasswordHash) {
  // eslint-disable-next-line no-console
  console.warn(
    'WARNING: ADMIN_PASSWORD_HASH is not set. Run `npm run hash-password` and set it in .env — /admin login will fail without it.'
  );
}

module.exports = config;
