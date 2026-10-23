/**
 * Express app + server bootstrap
 */

const express = require('express');
const corsMiddleware = require('cors');
const env = require('./config/env');
const prisma = require('./config/prisma');
const apiRoutes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { ensureAdminAccount } = require('./services/authService');
const logger = require('./utils/logger');
const { execFile } = require('child_process');

const app = express();

app.use(corsMiddleware({ origin: env.CORS_ORIGIN, exposedHeaders: ['Authorization'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    uptime: process.uptime()
  });
});

app.use('/api', apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Runs prisma migrate deploy and pings the connection.
 * @returns {Promise<void>}
 */
const setupDatabase = () =>
  new Promise((resolve, reject) => {
    execFile('npx', ['prisma', 'migrate', 'deploy'], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      logger.info(stdout.trim());
      prisma
        .$queryRaw`SELECT 1`
        .then(() => {
          logger.info('Database setup complete');
          resolve();
        })
        .catch(reject);
    });
  });

/**
 * Applies pending migrations, verifies the DB connection,
 * then seeds the bootstrap admin and starts listening
 * @param {number} [port]
 * @returns {Promise<import('http').Server>}
 */
const startServer = async (port = env.PORT) => {
  await setupDatabase();
  await ensureAdminAccount();

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      logger.info(`Bid and Code API listening on port ${port} (${env.NODE_ENV})`);
      resolve(server);
    });
  });
};

const shutdown = async (server) => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await prisma.$disconnect();
};

if (require.main === module) {
  startServer()
    .then((server) => {
      const stop = async () => {
        logger.info('Shutting down');
        await shutdown(server);
        process.exit(0);
      };

      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((error) => {
      logger.error('Failed to start server', error);
      process.exit(1);
    });
}

module.exports = {
  app,
  startServer,
  shutdown
};
