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
const http = require('http');
const { initSocket } = require('./socket');

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
  new Promise((resolve) => {
    execFile('npx', ['prisma', 'migrate', 'deploy'], (error, stdout) => {
      if (error) {
        logger.warn(`Prisma migrate deploy notice: ${error.message}`);
        resolve();
        return;
      }
      if (stdout) logger.info(stdout.trim());
      prisma
        .$queryRaw`SELECT 1`
        .then(() => {
          logger.info('Database connection verified');
          resolve();
        })
        .catch((err) => {
          logger.warn(`Database ping notice: ${err.message}`);
          resolve();
        });
    });
  });

/**
 * Starts the HTTP server on 0.0.0.0:PORT immediately so Render
 * detects open ports instantly, then initializes DB connection and admin account.
 * @param {number} [port]
 * @returns {Promise<import('http').Server>}
 */
const startServer = async (port = env.PORT) => {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    initSocket(server);

    server.listen(port, '0.0.0.0', async () => {
      logger.info(`Bid and Code API listening on 0.0.0.0:${port} (${env.NODE_ENV})`);
      resolve(server);

      // Initialize DB & bootstrap admin without blocking port detection
      try {
        await prisma.$connect();
        logger.info('Database connected successfully');
        await ensureAdminAccount();
      } catch (dbErr) {
        logger.error(`Database startup notice: ${dbErr.message}`);
      }
    });

    server.on('error', (err) => {
      logger.error('Server failed to start:', err);
      reject(err);
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
