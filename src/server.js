/**
 * Express app + server bootstrap
 */

const express = require('express');
const corsMiddleware = require('cors');
const env = require('./config/env');
const prisma = require('./config/prisma');
const apiRoutes = require('./routes');
const { errorHandler, notFoundHandler, describeError } = require('./middleware/errorHandler');
const { ensureAdminAccount } = require('./services/authService');
const logger = require('./utils/logger');
const { operationContext, runOperation } = require('./utils/operation');
const readiness = require('./services/readiness');
const http = require('http');
const { initSocket } = require('./socket');

const app = express();

app.use(corsMiddleware({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server) or from any Vercel / localhost origin
    if (!origin) return callback(null, true);

    const cleanOrigin = origin.replace(/\/$/, '');
    const cleanConfigured = (env.CORS_ORIGIN || '*').replace(/\/$/, '');

    if (
      cleanConfigured === '*' ||
      cleanOrigin === cleanConfigured ||
      cleanOrigin.endsWith('.vercel.app') ||
      cleanOrigin.includes('localhost') ||
      cleanOrigin.includes('127.0.0.1')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  exposedHeaders: ['Authorization', 'X-Server-Time', 'X-Server-Time-ISO']
}));
app.use((req, res, next) => {
  req._receiveTime = Date.now();
  res.setHeader('X-Server-Time', req._receiveTime.toString());
  res.setHeader('X-Server-Time-ISO', new Date(req._receiveTime).toISOString());
  next();
});
app.use(operationContext);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    uptime: process.uptime()
  });
});

app.get('/api/health/ready', async (req, res, next) => {
  try {
    if (['starting', 'unavailable'].includes(readiness.getReadiness().status)) throw readiness.readinessError();
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ success: true, status: 'ready' });
  } catch (error) { next(error); }
});

app.use('/api', readiness.requireDatabaseReady, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

let startupRetry = null;
let stopped = false;
const initializeDatabase = async () => {
  readiness.setReadiness({ status: 'starting' });
  try {
    await runOperation(async () => {
      await prisma.$connect();
      await ensureAdminAccount();
      await require('./services/gameService').getCurrentBiddingState();
    });
    if (!stopped) readiness.setReadiness({ status: 'ready' });
    logger.info('Database and bidding state initialized');
    return true;
  } catch (error) {
    const problem = describeError(error);
    const schemaMissing = ['P2021', 'P2022'].includes(problem.code);
    readiness.setReadiness({ status: 'unavailable',
      code: schemaMissing ? 'DATABASE_SCHEMA_OUTDATED' : problem.code || 'DATABASE_UNAVAILABLE',
      message: schemaMissing ? 'Apply the pending database migrations before starting the game.'
        : `${problem.statusCode === 503 ? problem.message : 'Database initialization failed.'} The server will retry initialization.` });
    logger.error(`Database initialization failed (${error.code || error.name}). ${readiness.getReadiness().message}`);
    return false;
  }
};
const bootstrapDatabase = async () => {
  if (await initializeDatabase() || stopped) return;
  startupRetry = setTimeout(bootstrapDatabase, 5000);
  startupRetry.unref?.();
};

/**
 * Starts the HTTP server on 0.0.0.0:PORT immediately so Render
 * detects open ports instantly, then initializes DB connection and admin account.
 * @param {number} [port]
 * @returns {Promise<import('http').Server>}
 */
const startServer = async (port = env.PORT) => {
  return new Promise((resolve, reject) => {
    stopped = false;
    readiness.setReadiness({ status: 'starting' });
    const server = http.createServer(app);
    initSocket(server);

    server.listen(port, '0.0.0.0', async () => {
      logger.info(`Bid and Code API listening on 0.0.0.0:${port} (${env.NODE_ENV})`);
      resolve(server);

      void bootstrapDatabase();
    });

    server.on('error', (err) => {
      logger.error('Server failed to start:', err);
      reject(err);
    });
  });
};

const shutdown = async (server) => {
  stopped = true;
  clearTimeout(startupRetry);
  require('./socket/timerManager').resetTimer();
  const io = require('./socket/emitter').getIO();
  if (io) await new Promise((resolve) => io.close(resolve));
  if (server?.listening) {
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
  shutdown,
  initializeDatabase
};
