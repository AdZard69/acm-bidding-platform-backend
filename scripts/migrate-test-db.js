/**
 * Applies prisma migrations to the test database (DATABASE_URL_TEST).
 * Run through `npm run prisma:migrate:test` before the test suite.
 */

require('dotenv').config();

const { execFileSync } = require('child_process');

const testDbUrl = process.env.DATABASE_URL_TEST;

if (!testDbUrl) {
  console.error('DATABASE_URL_TEST is not set, cannot migrate the test database');
  process.exit(1);
}

if (!/test/i.test(new URL(testDbUrl).pathname)) {
  console.error(`DATABASE_URL_TEST does not point at a test database: ${testDbUrl}`);
  process.exit(1);
}

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: testDbUrl },
  stdio: 'inherit'
});
