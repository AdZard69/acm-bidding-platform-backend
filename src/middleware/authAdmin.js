const { requireRole } = require('./auth');

const requireAdmin = requireRole('admin');

module.exports = {
  requireAdmin
};
