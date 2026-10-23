const ApiError = require('../utils/apiError');
const { verifyToken, extractBearerToken } = require('../utils/token');

const authenticate = (req, res, next) => {
  const token = extractBearerToken(req);

  if (!token) {
    return next(new ApiError(401, 'Authentication token is missing'));
  }

  try {
    req.auth = verifyToken(token);
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return next(new ApiError(401, 'Authentication token has expired'));
    }
    return next(new ApiError(401, 'Invalid authentication token'));
  }
};

const requireRole = (role) => (req, res, next) => {
  authenticate(req, res, (error) => {
    if (error) return next(error);
    if (req.auth.role !== role) {
      return next(new ApiError(403, `This endpoint is restricted to ${role} accounts`));
    }
    return next();
  });
};

module.exports = {
  authenticate,
  requireRole
};
