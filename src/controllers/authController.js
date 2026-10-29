const authService = require('../services/authService');
const ApiError = require('../utils/apiError');
const { validatePasswordChange, validateTeamInput } = require('../utils/validators');

const requireFields = (body, message) => {
  const missing = body.some((field) => field === undefined || field === null || field === '');
  if (missing) {
    throw new ApiError(400, message);
  }
};

const registerTeam = async (req, res, next) => {
  try {
    const { teamName, password } = req.body || {};
    requireFields([teamName, password], 'Team name and password are required');
    if (typeof teamName !== 'string' || !teamName.trim() || teamName.trim().length > 50 || typeof password !== 'string')
      throw new ApiError(400, 'Team name and password must be valid strings');

    const validation = validateTeamInput(teamName, password);
    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }

    const result = await authService.registerTeam(teamName, password);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

const registerAdmin = async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    requireFields([username, password], 'Username and password are required');
    if (typeof username !== 'string' || !username.trim() || username.trim().length > 50 || typeof password !== 'string')
      throw new ApiError(400, 'Username and password must be valid strings');

    if (typeof password !== 'string' || password.length < 6) {
      throw new ApiError(400, 'Password must be at least 6 characters long');
    }

    const result = await authService.registerAdmin(username, password);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

const teamLogin = async (req, res, next) => {
  try {
    const { teamName, password } = req.body || {};
    requireFields([teamName, password], 'Team name and password are required');
    if (typeof teamName !== 'string' || !teamName.trim() || teamName.trim().length > 50 || typeof password !== 'string')
      throw new ApiError(400, 'Team name and password must be valid strings');

    const result = await authService.authenticateTeam(teamName.trim(), password);
    res
      .set('Authorization', `Bearer ${result.token}`)
      .status(200)
      .json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

const adminLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    requireFields([username, password], 'Username and password are required');
    if (typeof username !== 'string' || !username.trim() || username.trim().length > 50 || typeof password !== 'string')
      throw new ApiError(400, 'Username and password must be valid strings');

    const result = await authService.authenticateAdmin(username.trim(), password);
    res
      .set('Authorization', `Bearer ${result.token}`)
      .status(200)
      .json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

const getMe = (req, res) => {
  res.status(200).json({ success: true, ...req.auth });
};

const logout = (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logged out. Discard the token on the client side.'
  });
};

const changeTeamPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const validation = validatePasswordChange(currentPassword, newPassword);
    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }

    const result = await authService.changePassword(
      'team',
      req.auth.teamId,
      currentPassword,
      newPassword
    );

    res.status(200).json({ success: true, message: 'Password updated', ...result });
  } catch (error) {
    next(error);
  }
};

const changeAdminPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const validation = validatePasswordChange(currentPassword, newPassword);
    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }

    const result = await authService.changePassword(
      'admin',
      req.auth.adminId,
      currentPassword,
      newPassword
    );

    res.status(200).json({ success: true, message: 'Password updated', ...result });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  registerTeam,
  registerAdmin,
  teamLogin,
  adminLogin,
  getMe,
  logout,
  changeTeamPassword,
  changeAdminPassword
};
