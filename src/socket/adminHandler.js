const SOCKET_EVENTS = require('../constants/socketEvents');
const gameService = require('../services/gameService');
const logger = require('../utils/logger');

/**
 * Registers admin socket event handlers
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
const registerAdminHandlers = (io, socket) => {
  const adminId = socket.user?.adminId;

  socket.on(SOCKET_EVENTS.ADMIN.START_ROUND, async (data, ack) => {
    try {
      const round = data?.roundNumber ?? data?.round;
      const res = await gameService.startRound(round, adminId);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Admin socket start-round error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.ADMIN.PAUSE, async (_, ack) => {
    try {
      const res = await gameService.pauseRound(adminId);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Admin socket pause error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.ADMIN.RESUME, async (_, ack) => {
    try {
      const res = await gameService.resumeRound(adminId);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Admin socket resume error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.ADMIN.EXTEND, async (data, ack) => {
    try {
      const extraSeconds = data?.extraSeconds ?? data?.seconds;
      const res = await gameService.extendRound(extraSeconds, adminId);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Admin socket extend error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.ADMIN.NEXT_PROMPT, async (_, ack) => {
    try {
      const res = await gameService.nextPrompt(adminId);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Admin socket next-prompt error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.ADMIN.END_ROUND, async (_, ack) => {
    try {
      const res = await gameService.endRound(adminId);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Admin socket end-round error: ${err.message}`);
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });
};

module.exports = registerAdminHandlers;
