/**
 * Test bootstrap.
 * Points prisma at the test database before anything else is required, then
 * exposes helpers for resetting the database between tests.
 */

require('dotenv').config();

const testDbUrl = process.env.DATABASE_URL_TEST;

if (!testDbUrl) {
  throw new Error('DATABASE_URL_TEST is not set, refusing to run tests against an unknown database');
}

if (!/test/i.test(new URL(testDbUrl).pathname)) {
  throw new Error(`DATABASE_URL_TEST does not point at a test database: ${testDbUrl}`);
}

process.env.DATABASE_URL = testDbUrl;
process.env.DIRECT_URL = testDbUrl;
process.env.NODE_ENV = process.env.NODE_ENV_TEST || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const prisma = require('../../src/config/prisma');
const { hashPassword } = require('../../src/utils/password');

const TABLES = ['bids', 'assignments', 'scores', 'admin_logs', 'admins', 'teams', 'prompts', 'game_config'];

/**
 * Wipes every table and resets the id sequences
 */
const resetDatabase = async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`
  );
};

/**
 * Creates a team with a bcrypt hashed password
 * @param {string} teamName
 * @param {string} password
 * @returns {Promise<object>} created team
 */
const createTeam = async (teamName, password) => {
  return prisma.team.create({
    data: {
      teamName,
      password: await hashPassword(password)
    }
  });
};

module.exports = {
  prisma,
  resetDatabase,
  createTeam
};
