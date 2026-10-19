const { PrismaClient } = require('@prisma/client');
const env = require('./env');

const prismaClientSingleton = () => {
  return new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
  });
};

const globalForPrisma = global;

const prisma = globalForPrisma.prismaGlobal || prismaClientSingleton();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prismaGlobal = prisma;
}

module.exports = prisma;
