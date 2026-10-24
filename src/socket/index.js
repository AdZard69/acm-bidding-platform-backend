const { Server } = require('socket.io');
const { authSocket } = require('../middleware/authSocket');
const { ROLES } = require('../utils/token');
const logger = require('../utils/logger');
const env = require('../config/env');

let ioInstance = null;

/**
 * Returns the current Socket.IO instance or null
 * @returns {import('socket.io').Server|null}
 */
const getIO = () => ioInstance;

/**
 * Helper to broadcast an event to everyone
 * @param {string} event
 * @param {any} data
 */
const broadcast = (event, data) => {
  if (ioInstance) {
    ioInstance.emit(event, data);
  }
};

/**
 * Helper to emit an event to a specific team room
 * @param {number} teamId
 * @param {string} event
 * @param {any} data
 */
const sendToTeam = (teamId, event, data) => {
  if (ioInstance) {
    ioInstance.to(`team:${teamId}`).emit(event, data);
  }
};

/**
 * Initializes Socket.IO with the HTTP server
 * @param {import('http').Server} server
 * @returns {import('socket.io').Server}
 */
const initSocket = (server) => {
  const registerAdminHandlers = require('./adminHandler');
  const registerBidHandlers = require('./bidHandler');

  ioInstance = new Server(server, {
    cors: {
      origin: env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      exposedHeaders: ['Authorization']
    }
  });

  ioInstance.use(authSocket);

  ioInstance.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (role: ${socket.user?.role})`);

    if (socket.user?.role === ROLES.ADMIN) {
      socket.join('admin');
      registerAdminHandlers(ioInstance, socket);
    } else if (socket.user?.role === ROLES.TEAM) {
      socket.join(`team:${socket.user.teamId}`);
      socket.join('teams');
      registerBidHandlers(ioInstance, socket);
    }

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  return ioInstance;
};

module.exports = {
  initSocket,
  getIO,
  broadcast,
  sendToTeam
};
