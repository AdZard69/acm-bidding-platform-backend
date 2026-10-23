const prisma = require('../config/prisma');
const ApiError = require('../utils/apiError');
const { hashPassword } = require('../utils/password');

const getTeamOrThrow = async (id) => {
  const team = await prisma.team.findUnique({ where: { id: id } });

  if (!team) {
    throw new ApiError(404, 'Team not found');
  }

  return team;
};

const listTeams = async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        teamName: true,
        isActive: true,
        createdAt: true
      }
    });

    res.status(200).json({ success: true, teams });
  } catch (error) {
    next(error);
  }
};

const createTeam = async (req, res, next) => {
  try {
    const { teamName, password } = req.body || {};

    if (!teamName || typeof teamName !== 'string' || !teamName.trim()) {
      throw new ApiError(400, 'Team name is required');
    }

    if (!password || typeof password !== 'string' || password.length < 4) {
      throw new ApiError(400, 'Password must be at least 4 characters long');
    }

    const existing = await prisma.team.findUnique({
      where: { teamName: teamName.trim() }
    });

    if (existing) {
      throw new ApiError(409, 'A team with that name already exists');
    }

    const team = await prisma.team.create({
      data: {
        teamName: teamName.trim(),
        password: await hashPassword(password)
      }
    });

    res.status(201).json({
      success: true,
      team: {
        id: team.id,
        teamName: team.teamName,
        isActive: team.isActive,
        createdAt: team.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

const updateTeam = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getTeamOrThrow(id);

    const { teamName, password, isActive } = req.body || {};

    if (!teamName && !password && isActive === undefined) {
      throw new ApiError(400, 'Nothing to update: provide teamName, password, or isActive');
    }

    const data = {};

    if (teamName !== undefined) {
      if (typeof teamName !== 'string' || !teamName.trim()) {
        throw new ApiError(400, 'Team name cannot be empty');
      }
      data.teamName = teamName.trim();
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 4) {
        throw new ApiError(400, 'Password must be at least 4 characters long');
      }
      data.password = await hashPassword(password);
    }

    if (isActive !== undefined) {
      data.isActive = Boolean(isActive);
    }

    if (data.teamName) {
      const duplicate = await prisma.team.findUnique({ where: { teamName: data.teamName } });
      if (duplicate && duplicate.id !== id) {
        throw new ApiError(409, 'A team with that name already exists');
      }
    }

    const team = await prisma.team.update({ where: { id }, data });

    res.status(200).json({
      success: true,
      team: {
        id: team.id,
        teamName: team.teamName,
        isActive: team.isActive,
        createdAt: team.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

const deleteTeam = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getTeamOrThrow(id);

    await prisma.$transaction([
      prisma.bid.deleteMany({ where: { teamId: id } }),
      prisma.assignment.deleteMany({ where: { teamId: id } }),
      prisma.score.deleteMany({ where: { teamId: id } }),
      prisma.team.delete({ where: { id } })
    ]);

    res.status(200).json({ success: true, message: 'Team removed' });
  } catch (error) {
    next(error);
  }
};

const toggleTeam = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const team = await getTeamOrThrow(id);

    const updated = await prisma.team.update({
      where: { id },
      data: { isActive: !team.isActive }
    });

    res.status(200).json({
      success: true,
      team: {
        id: updated.id,
        teamName: updated.teamName,
        isActive: updated.isActive
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  toggleTeam
};
