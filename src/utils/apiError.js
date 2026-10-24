class ApiError extends Error { 
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  static create(statusCode, message, details = undefined) {
    return new ApiError(statusCode, message, details);
  }
}

module.exports = ApiError;
