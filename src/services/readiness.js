const ApiError = require('../utils/apiError');
let state = { status: 'idle' };
const setReadiness = (next) => { state = next; };
const getReadiness = () => state;
const readinessError = () => {
  const error = new ApiError(503, state.message || 'The database is still initializing. Please retry shortly.');
  error.code = state.code || 'DATABASE_STARTING';
  return error;
};
const requireDatabaseReady = (req, res, next) => {
  // Liveness, documentation, session claims and ping do not need a database.
  const independent = ['/health', '/health/ready', '/docs', '/docs.json', '/clock/sync', '/auth/me', '/auth/logout'];
  if (['starting', 'unavailable'].includes(state.status) && !independent.includes(req.path.replace(/\/$/, ''))) {
    return next(readinessError());
  }
  next();
};
module.exports = { getReadiness, setReadiness, readinessError, requireDatabaseReady };
