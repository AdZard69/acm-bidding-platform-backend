const prisma = require('../config/prisma');
const ApiError = require('../utils/apiError');
const { hashPassword } = require('../utils/password');
const { validatePromptInput, validateGameConfig } = require('../utils/validators');
const gameService = require('../services/gameService');
const scoreController = require('./scoreController');
const timerManager = require('../socket/timerManager');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const { broadcast } = require('../socket');

const getTeamOrThrow = async (id) => {
  if (!Number.isInteger(id)) {
    throw new ApiError(400, 'Invalid team id');
  }
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
        createdAt: true,
        assignment:true
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

const getPromptOrThrow = async (id) => {
  if (!Number.isInteger(id)) {
    throw new ApiError(400, 'Invalid prompt id');
  }
  const prompt = await prisma.prompt.findUnique({ where: { id } });

  if (!prompt) {
    throw new ApiError(404, 'Prompt not found');
  }

  return prompt;
};

const listPrompts = async (req, res, next) => {
  try {
    const prompts = await prisma.prompt.findMany({
      orderBy: { displayOrder: 'asc' }
    });

    res.status(200).json({ success: true, prompts });
  } catch (error) {
    next(error);
  }
};

const createPrompt = async (req, res, next) => {
  try {
    const { title, description, displayOrder } = req.body || {};

    const validation = validatePromptInput(title, description, displayOrder);
    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }

    let orderedDisplay;
    if (displayOrder !== undefined) {
      orderedDisplay = Number(displayOrder);
    } else {
      const max = await prisma.prompt.aggregate({ _max: { displayOrder: true } });
      orderedDisplay = (max._max.displayOrder ?? 0) + 1;
    }

    const prompt = await prisma.prompt.create({
      data: {
        title: title.trim(),
        description: description.trim(),
        displayOrder: orderedDisplay
      }
    });

    res.status(201).json({ success: true, prompt });
  } catch (error) {
    next(error);
  }
};

const updatePrompt = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getPromptOrThrow(id);

    const { title, description, displayOrder } = req.body || {};

    if (!title && !description && displayOrder === undefined) {
      throw new ApiError(400, 'Nothing to update: provide title, description, or displayOrder');
    }

    const validation = validatePromptInput(
      title ?? 'valid title',
      description ?? 'valid description',
      displayOrder
    );
    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }

    const prompt = await prisma.prompt.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description: description.trim() } : {}),
        ...(displayOrder !== undefined ? { displayOrder: Number(displayOrder) } : {})
      }
    });

    res.status(200).json({ success: true, prompt });
  } catch (error) {
    next(error);
  }
};

const deletePrompt = async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await getPromptOrThrow(id);

    await prisma.$transaction([
      prisma.bid.deleteMany({ where: { promptId: id } }),
      prisma.assignment.deleteMany({ where: { promptId: id } }),
      prisma.prompt.delete({ where: { id } })
    ]);

    res.status(200).json({ success: true, message: 'Prompt removed' });
  } catch (error) {
    next(error);
  }
};

const startRound = async (req, res, next) => {
  try {
    const { round, roundNumber } = req.body || {};
    const targetRound = round !== undefined ? round : roundNumber;
    const result = await gameService.startRound(targetRound, req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const pauseRound = async (req, res, next) => {
  try {
    const result = await gameService.pauseRound(req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const resumeRound = async (req, res, next) => {
  try {
    const result = await gameService.resumeRound(req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const extendRound = async (req, res, next) => {
  try {
    const { extraSeconds, seconds } = req.body || {};
    const extra = extraSeconds !== undefined ? extraSeconds : seconds;
    const result = await gameService.extendRound(extra, req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const nextPrompt = async (req, res, next) => {
  try {
    const result = await gameService.nextPrompt(req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const endRound = async (req, res, next) => {
  try {
    const result = await gameService.endRound(req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const resetGame = async (req, res, next) => {
  try {
    const { wipeTeams, wipePrompts, wipeAll } = req.body || {};

    timerManager.resetTimer();

    await prisma.$transaction([
      prisma.bid.deleteMany(),
      prisma.assignment.deleteMany(),
      prisma.score.deleteMany()
    ]);

    if (wipeTeams || wipeAll) {
      await prisma.team.deleteMany();
    }

    if (wipePrompts || wipeAll) {
      await prisma.prompt.deleteMany();
    }

    await prisma.gameConfig.updateMany({
      data: {
        currentRound: 0,
        currentPromptIndex: -1,
        status: GAME_STATUS.WAITING
      }
    });

    await prisma.adminLog.create({
      data: {
        adminId: req.auth?.adminId || null,
        action: 'RESET',
        details: `Game state reset to initial waiting state${wipeAll ? ' (all teams and prompts wiped)' : ''}`
      }
    });

    broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, {
      status: GAME_STATUS.WAITING,
      currentRound: 0,
      currentPrompt: null
    });

    res.status(200).json({
      success: true,
      message: 'Game reset successfully',
      status: GAME_STATUS.WAITING
    });
  } catch (error) {
    next(error);
  }
};

const getConfig = async (req, res, next) => {
  try {
    const config = await gameService.getOrCreateGameConfig();
    res.status(200).json({ success: true, config });
  } catch (error) {
    next(error);
  }
};

const updateConfig = async (req, res, next) => {
  try {
    const { baseTime, minBid, maxTeams, slotsPerPrompt, bidDurationSeconds } = req.body || {};

    if (
      baseTime === undefined &&
      minBid === undefined &&
      maxTeams === undefined &&
      slotsPerPrompt === undefined &&
      bidDurationSeconds === undefined
    ) {
      throw new ApiError(400, 'Nothing to update: provide at least one configuration field');
    }

    const currentConfig = await gameService.getOrCreateGameConfig();

    if (
      currentConfig.status === GAME_STATUS.BIDDING ||
      currentConfig.status === GAME_STATUS.PAUSED
    ) {
      throw new ApiError(400, 'Cannot update game settings while a round is in progress');
    }

    const validation = validateGameConfig({
      baseTime,
      minBid,
      maxTeams,
      slotsPerPrompt,
      bidDurationSeconds
    });

    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }

    const data = {};
    if (baseTime !== undefined) data.baseTime = Number(baseTime);
    if (minBid !== undefined) data.minBid = Number(minBid);
    if (maxTeams !== undefined) data.maxTeams = Number(maxTeams);
    if (slotsPerPrompt !== undefined) data.slotsPerPrompt = Number(slotsPerPrompt);
    if (bidDurationSeconds !== undefined) data.bidDurationSeconds = Number(bidDurationSeconds);

    const targetBaseTime = data.baseTime !== undefined ? data.baseTime : currentConfig.baseTime;
    const targetMinBid = data.minBid !== undefined ? data.minBid : currentConfig.minBid;

    if (targetMinBid > targetBaseTime) {
      throw new ApiError(400, 'minBid cannot be greater than baseTime');
    }

    const updated = await prisma.gameConfig.update({
      where: { id: currentConfig.id },
      data
    });

    await prisma.adminLog.create({
      data: {
        adminId: req.auth?.adminId || null,
        action: 'CONFIG_UPDATE',
        details: `Updated game config: ${JSON.stringify(data)}`
      }
    });

    res.status(200).json({
      success: true,
      message: 'Game configuration updated successfully',
      config: updated
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
  toggleTeam,
  listPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  startRound,
  pauseRound,
  resumeRound,
  extendRound,
  nextPrompt,
  endRound,
  submitScore: scoreController.submitScore,
  getLeaderboard: scoreController.getLeaderboard,
  resetGame,
  getConfig,
  updateConfig
};
