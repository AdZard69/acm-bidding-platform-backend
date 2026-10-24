const { requireRole } = require('./auth');

const requireTeam = requireRole('team');

module.exports = {
  requireTeam
};
