const { PrismaClient } = require('@prisma/client');
const env = require('./env');
const { databaseUrl } = require('./databaseUrl');
const { assertOperationActive } = require('../utils/operation');

const prismaClientSingleton = () => {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl(env.DATABASE_URL, env) } },
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
  });
  client.$use(async (params, next) => {
    assertOperationActive();
    return next(params);
  });
  return client;
};

const globalForPrisma = global;

const prisma = globalForPrisma.prismaGlobal || prismaClientSingleton();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prismaGlobal = prisma;
}

module.exports = prisma;
