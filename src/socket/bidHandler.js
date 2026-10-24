const SOCKET_EVENTS = require('../constants/socketEvents');
const logger = require('../utils/logger');
const { placeBidInternal, updateBidInternal } = require('../controllers/bidController');

/**
 * Registers bid socket event handlers for teams
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
const registerBidHandlers = (io, socket) => {
  const teamId = socket.user?.teamId;

  socket.on(SOCKET_EVENTS.CLIENT.BID_PLACE, async (data, ack) => {
    try {
      const bidMinutes = data?.bidMinutes !== undefined ? data.bidMinutes : data?.bid;
      const res = await placeBidInternal(teamId, bidMinutes);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Bid socket place error: ${err.message}`);
      socket.emit(SOCKET_EVENTS.SERVER.ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });

  socket.on(SOCKET_EVENTS.CLIENT.BID_UPDATE, async (data, ack) => {
    try {
      const bidMinutes = data?.bidMinutes !== undefined ? data.bidMinutes : data?.bid;
      const res = await updateBidInternal(teamId, bidMinutes);
      if (typeof ack === 'function') ack({ success: true, ...res });
    } catch (err) {
      logger.warn(`Bid socket update error: ${err.message}`);
      socket.emit(SOCKET_EVENTS.SERVER.ERROR, { message: err.message });
      if (typeof ack === 'function') ack({ success: false, error: { message: err.message } });
    }
  });
};

module.exports = registerBidHandlers;
