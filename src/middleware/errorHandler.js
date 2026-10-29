
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const logger = require('../utils/logger');


const notFoundHandler = (req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};


const describeError = (error) => {
  const code = error.code || error.errorCode;
  let statusCode = error.statusCode || error.status || 500;
  let message = error.message || 'Internal server error';
  let details = error.details;

  if (['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1010', 'P1011', 'P1013', 'P1017', 'P2024', 'P2028', 'P2037'].includes(code)) {
    statusCode = 503;
    message = 'The database is temporarily unavailable or busy. Please retry shortly.';
    const configurationErrors = {
      P1000: 'Database authentication failed. Check the backend database credentials.',
      P1001: 'The backend cannot reach the database. Check its host, port, and network access.',
      P1003: 'The configured database does not exist.',
      P1010: 'The database user does not have permission to access this database.',
      P1011: 'The backend could not establish a secure database connection.',
      P1013: 'The backend database connection URL is invalid.'
    };
    message = configurationErrors[code] || message;
  } else if (['P2021', 'P2022'].includes(code)) {
    statusCode = 503;
    message = 'The database schema is out of date. Apply the pending database migrations.';
  } else if (code === 'P2002') {
    statusCode = 409;
    message = 'That value is already taken';
    details = { fields: error.meta?.target };
  } else if (code === 'P2025') {
    statusCode = 404;
    message = 'Resource not found';
  } else if (code === 'P2003') {
    statusCode = 400;
    message = 'Referenced resource does not exist';
  } else if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Invalid authentication token';
  }

  return { statusCode, message, details, code };
};

const errorHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const { statusCode, message, details, code } = describeError(error);

  if (statusCode === 503) {
    logger.warn(`${req.method} ${req.originalUrl} -> 503 (${code || 'SERVICE_UNAVAILABLE'}): ${message}`);
  } else if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${statusCode}: ${error.message}`, error.stack);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${statusCode}: ${message}`);
  }

  const body = {
    success: false,
    error: {
      message,
      ...(statusCode === 503 ? { code: code || 'SERVICE_UNAVAILABLE' } : {})
    }
  };
  if (statusCode === 503) res.setHeader('Retry-After', '3');

  if (details) {
    body.error.details = details;
  }

  if (env.NODE_ENV === 'development' && statusCode >= 500 && statusCode !== 503) {
    body.error.stack = error.stack;
  }

  res.status(statusCode).json(body);
};

module.exports = {
  ApiError,
  notFoundHandler,
  errorHandler,
  describeError
};
