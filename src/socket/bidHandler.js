const { describeError } = require('../middleware/errorHandler');
const { submitBid } = require('../services/bidService');

module.exports = (io, socket) => {
  const handler = async (data, ack) => {
    try {
      const result = await submitBid(socket.user?.teamId, data);
      if (typeof ack === 'function') ack(result);
    } catch (err) {
      if (typeof ack === 'function') ack({ success: false, error: { message: describeError(err).message, code: describeError(err).code } });
    }
  };
  socket.on('bid:place', handler);
  socket.on('bid:update', handler);
};
