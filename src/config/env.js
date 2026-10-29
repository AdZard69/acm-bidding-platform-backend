const dotenv = require('dotenv');

dotenv.config();

const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET'];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`[WARN] Missing environment variable: ${envVar}. Using fallback or expecting .env configuration.`);
  }
}

const positiveInteger = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 5000,
  DATABASE_URL: process.env.DATABASE_URL || '',
  DIRECT_URL: process.env.DIRECT_URL || '',
  DATABASE_URL_TEST: process.env.DATABASE_URL_TEST || '',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
  JWT_ISSUER: process.env.JWT_ISSUER || 'acm-bidding-platform',
  BCRYPT_SALT_ROUNDS: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 10,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  DB_CONNECTION_LIMIT: positiveInteger('DB_CONNECTION_LIMIT', 5),
  DB_CONNECT_TIMEOUT_SECONDS: positiveInteger('DB_CONNECT_TIMEOUT_SECONDS', 5),
  DB_POOL_TIMEOUT_SECONDS: positiveInteger('DB_POOL_TIMEOUT_SECONDS', 3),
  DB_QUERY_TIMEOUT_SECONDS: positiveInteger('DB_QUERY_TIMEOUT_SECONDS', 3),
  OPERATION_TIMEOUT_MS: positiveInteger('OPERATION_TIMEOUT_MS', 10000),
  GAME_QUEUE_WAIT_MS: positiveInteger('GAME_QUEUE_WAIT_MS', 3000)
};

module.exports = Object.freeze(env);
