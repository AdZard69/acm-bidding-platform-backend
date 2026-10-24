
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const ROLES = Object.freeze({
  TEAM: 'team',
  ADMIN: 'admin'
});


const signToken = (payload) => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: env.JWT_ISSUER
  });
};

const verifyToken = (token) => {
  return jwt.verify(token, env.JWT_SECRET, { issuer: env.JWT_ISSUER });
};

const signTeamToken = (team) => {
  return signToken({
    sub: String(team.id),
    role: ROLES.TEAM,
    teamId: team.id,
    teamName: team.teamName
  });
};


const signAdminToken = (admin) => {
  return signToken({
    sub: String(admin.id),
    role: ROLES.ADMIN,
    adminId: admin.id,
    username: admin.username
  });
};

const extractBearerToken = (req) => {
  const header = req.headers?.authorization || req.headers?.Authorization;

  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }

  return null;
};

module.exports = {
  ROLES,
  signToken,
  verifyToken,
  signTeamToken,
  signAdminToken,
  extractBearerToken
};
