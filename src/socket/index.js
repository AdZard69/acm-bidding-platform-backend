const { Server } = require('socket.io');
const { authSocket } = require('../middleware/authSocket');
const { ROLES } = require('../utils/token');
const logger = require('../utils/logger');
const env = require('../config/env');
const { setIO, getIO, broadcast, sendToTeam } = require('./emitter');
const registerAdminHandlers = require('./adminHandler');
const registerBidHandlers = require('./bidHandler');
const SOCKET_EVENTS = require('../constants/socketEvents');

/**
 * Initializes Socket.IO with the HTTP server
 * @param {import('http').Server} server
 * @returns {import('socket.io').Server}
 */
const initSocket = (server) => {
  const ioInstance = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        callback(null, true);
      },
      methods: ['GET', 'POST'],
      exposedHeaders: ['Authorization', 'X-Server-Time', 'X-Server-Time-ISO'],
      credentials: true
    }
  });

  setIO(ioInstance);

  ioInstance.use(authSocket);

  ioInstance.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (role: ${socket.user?.role})`);

    const handleTimeSync = (data, ack) => {
      const serverReceiveTime = Date.now();
      const payload = {
        clientTime: data?.clientTime ?? data?.t0 ?? null,
        serverReceiveTime,
        serverTransmitTime: Date.now(),
        serverTime: serverReceiveTime,
        serverTimeIso: new Date(serverReceiveTime).toISOString()
      };
      if (typeof ack === 'function') {
        ack(payload);
      } else {
        socket.emit(SOCKET_EVENTS.SERVER.TIME_SYNC, payload);
      }
    };

    socket.on(SOCKET_EVENTS.CLIENT.TIME_SYNC, handleTimeSync);
    socket.on('clock:sync', handleTimeSync);

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
  sendToTeam,
  setIO
};
