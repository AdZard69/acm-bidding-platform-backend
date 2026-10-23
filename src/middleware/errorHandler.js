
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const logger = require('../utils/logger');


const notFoundHandler = (req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};


const errorHandler = (error, req, res, next) => {
  let statusCode = error.statusCode || 500;
  let message = error.message || 'Internal server error';
  let details = error.details;

  if (error.code === 'P2002') {
    statusCode = 409;
    message = 'That value is already taken';
    details = { fields: error.meta?.target };
  } else if (error.code === 'P2025') {
    statusCode = 404;
    message = 'Resource not found';
  } else if (error.code === 'P2003') {
    statusCode = 400;
    message = 'Referenced resource does not exist';
  } else if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Invalid authentication token';
  }

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${statusCode}: ${error.message}`, error.stack);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${statusCode}: ${message}`);
  }

  const body = {
    success: false,
    error: {
      message
    }
  };

  if (details) {
    body.error.details = details;
  }

  if (env.NODE_ENV === 'development' && statusCode >= 500) {
    body.error.stack = error.stack;
  }

  res.status(statusCode).json(body);
};

module.exports = {
  ApiError,
  notFoundHandler,
  errorHandler
};
