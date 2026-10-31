const ApiError = require('../utils/apiError');
const env = require('../config/env');
const { runOperation, bindOperation, outsideOperation } = require('../utils/operation');

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
  return (operation, { mustRun = false } = {}) => runOperation(() => new Promise((resolve, reject) => {
    if (!mustRun && queue.length >= maxPending) return reject(busy());
    // Server expiry must survive a busy queue, and gets its own execution budget
    // when its turn arrives. User requests retain bounded admission/wait times.
    const execute = mustRun ? () => outsideOperation(() => runOperation(operation)) : bindOperation(operation);
    const entry = { operation: execute, resolve, reject };
    if (!mustRun) entry.timeout = setTimeout(() => {
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
