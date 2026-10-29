const ApiError = require('../utils/apiError');
const env = require('../config/env');
const { runOperation, bindOperation } = require('../utils/operation');

// Waiting requests can expire, but an executing mutation keeps ownership until
// it settles. Racing/releasing a running write would allow late bids after awards.
const createGameQueue = ({ waitTimeoutMs = env.GAME_QUEUE_WAIT_MS, maxPending = 64 } = {}) => {
  const queue = [];
  let running = false;
  const busy = () => {
    const error = new ApiError(503, 'The game is busy waiting for the database. Please retry shortly.');
    error.code = 'GAME_BUSY';
    return error;
  };
  const drain = () => {
    if (running || !queue.length) return;
    const entry = queue.shift();
    clearTimeout(entry.timeout);
    running = true;
    Promise.resolve().then(entry.operation).then(entry.resolve, entry.reject).finally(() => {
      running = false;
      drain();
    });
  };
  return (operation) => runOperation(() => new Promise((resolve, reject) => {
    if (queue.length >= maxPending) return reject(busy());
    const entry = { operation: bindOperation(operation), resolve, reject };
    entry.timeout = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      reject(busy());
    }, waitTimeoutMs);
    queue.push(entry);
    drain();
  }));
};

module.exports = { withGameLock: createGameQueue(), createGameQueue };
