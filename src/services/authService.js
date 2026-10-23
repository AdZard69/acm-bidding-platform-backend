const prisma = require('../config/prisma');
const env = require('../config/env');
const ApiError = require('../utils/apiError');
const { hashPassword, verifyPassword } = require('../utils/password');
const { signTeamToken, signAdminToken } = require('../utils/token');
const logger = require('../utils/logger');


const registerTeam = async (teamName, password) => {
  const existing = await prisma.team.findUnique({
    where: { teamName: teamName.trim() }
  });

  if (existing) {
    throw new ApiError(409, 'A team with that name is already registered');
  }

  const team = await prisma.team.create({
    data: {
      teamName: teamName.trim(),
      password: await hashPassword(password)
    }
  });

  return {
    token: signTeamToken(team),
    teamId: team.id,
    teamName: team.teamName
  };
};

const registerAdmin = async (username, password) => {
  const existing = await prisma.admin.findUnique({
    where: { username: username.trim() }
  });

  if (existing) {
    throw new ApiError(409, 'An admin with that username already exists');
  }

  const admin = await prisma.admin.create({
    data: {
      username: username.trim(),
      password: await hashPassword(password),
      role: 'admin'
    }
  });

  return {
    token: signAdminToken(admin),
    role: admin.role,
    adminId: admin.id,
    username: admin.username
  };
};

const authenticateTeam = async (teamName, password) => {
  const team = await prisma.team.findUnique({
    where: { teamName }
  });

  if (!team) {
    throw new ApiError(401, 'No team found with that name');
  }

  const passwordMatches = await verifyPassword(password, team.password);

  if (!passwordMatches) {
    throw new ApiError(401, 'Incorrect password');
  }

  if (!team.isActive) {
    throw new ApiError(403, 'This team has been deactivated. Speak to the admin.');
  }

  return {
    token: signTeamToken(team),
    teamId: team.id,
    teamName: team.teamName
  };
};


const authenticateAdmin = async (username, password) => {
  const admin = await prisma.admin.findUnique({
    where: { username }
  });

  if (!admin) {
    throw new ApiError(401, 'No admin found with that username');
  }

  const passwordMatches = await verifyPassword(password, admin.password);

  if (!passwordMatches) {
    throw new ApiError(401, 'Incorrect password');
  }

  return {
    token: signAdminToken(admin),
    role: admin.role,
    adminId: admin.id,
    username: admin.username
  };
};

const ensureAdminAccount = async () => {
  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;

  if (!username || !password) {
    logger.warn('ADMIN_USERNAME / ADMIN_PASSWORD not set, skipping admin bootstrap');
    return null;
  }

  const existing = await prisma.admin.findUnique({
    where: { username }
  });

  if (existing) {
    logger.info(`Admin account "${username}" already exists, skipping bootstrap`);
    return { id: existing.id, username: existing.username, created: false };
  }

  const hashedPassword = await hashPassword(password);
  const admin = await prisma.admin.create({
    data: {
      username,
      password: hashedPassword,
      role: 'admin'
    }
  });

  logger.info(`Admin account "${username}" created from environment`);
  return { id: admin.id, username: admin.username, created: true };
};

const changePassword = async (model, id, currentPassword, newPassword) => {
  const user = await prisma[model].findUnique({
    where: { id }
  });

  if (!user) {
    throw new ApiError(404, `${model === 'team' ? 'Team' : 'Admin'} not found`);
  }

  const passwordMatches = await verifyPassword(currentPassword, user.password);

  if (!passwordMatches) {
    throw new ApiError(401, 'Current password is incorrect');
  }

  await prisma[model].update({
    where: { id },
    data: { password: await hashPassword(newPassword) }
  });

  return model === 'team'
    ? { teamId: user.id, teamName: user.teamName }
    : { adminId: user.id, username: user.username };
};

module.exports = {
  registerTeam,
  registerAdmin,
  authenticateTeam,
  authenticateAdmin,
  ensureAdminAccount,
  changePassword
};
