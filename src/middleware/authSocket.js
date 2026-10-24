const { verifyToken } = require('../utils/token');

/**
 * Socket.IO authentication middleware.
 * Verifies JWT from handshake auth token or Authorization header.
 */
const authSocket = (socket, next) => {
  try {
    const authHeader = socket.handshake.headers?.authorization;
    const token =
      socket.handshake.auth?.token ||
      (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : null);

    if (!token) {
      return next(new Error('Authentication token is missing'));
    }

    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Invalid authentication token'));
  }
};

module.exports = {
  authSocket
};
