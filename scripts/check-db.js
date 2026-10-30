const prisma = require('../src/config/prisma');
const env = require('../src/config/env');
const { runOperation } = require('../src/utils/operation');
const { describeError } = require('../src/middleware/errorHandler');

const checkDatabase = async () => {
  // Print only the target, never credentials or the full connection string.
  if (env.DATABASE_URL) {
    const target = new URL(env.DATABASE_URL);
    console.log(`Checking PostgreSQL at ${target.hostname}:${target.port || '5432'}${target.pathname}`);
  }
  try {
    await runOperation(async () => {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      await prisma.gameConfig.findFirst({ select: { id: true, biddingState: true } });
    });
    console.log('Database connection and bidding timer schema are ready.');
    return true;
  } catch (error) {
    const result = describeError(error);
    console.error(`Database check failed (${result.code || error.name}): ${result.message}`);
    return false;
  } finally {
    await prisma.$disconnect();
  }
};
if (require.main === module) checkDatabase().then((ok) => { process.exitCode = ok ? 0 : 1; });
module.exports = { checkDatabase };
