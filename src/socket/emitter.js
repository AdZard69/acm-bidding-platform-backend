/**
 * Socket Emitter
 * Isolates Socket.IO instance emission functions to break circular dependencies
 * between services (like gameService) and socket handlers/server setup.
 */

let ioInstance = null;

/**
 * Sets the active Socket.IO server instance
 * @param {import('socket.io').Server|null} io
 */
const setIO = (io) => {
  ioInstance = io;
};

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

module.exports = {
  setIO,
  getIO,
  broadcast,
  sendToTeam
};
