const prisma = require('../config/prisma');
const ApiError = require('../utils/apiError');
const { hashPassword } = require('../utils/password');
const { validatePromptInput, validateGameConfig, validateTeamInput, isIntegerInput } = require('../utils/validators');
const gameService = require('../services/gameService');
const scoreController = require('./scoreController');
const timerManager = require('../socket/timerManager');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const { broadcast } = require('../socket/emitter');
const { withGameLock } = require('../services/gameLock');
const { getRoundDefinitions, promptRound } = require('../services/roundService');

const getTeamOrThrow = async (id) => {
  if (!isIntegerInput(id) || id <= 0) {
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
        assignment: { include: { prompt: true } },
        score: true
      }
    });

    const rounds = await getRoundDefinitions(await gameService.getOrCreateGameConfig());
    res.status(200).json({ success: true, teams: teams.map((team) => ({
      ...team,
      assignment: team.assignment ? { ...promptRound(team.assignment, rounds), multiplier: Number(team.assignment.multiplier) } : null,
      score: team.score ? { ...team.score, multiplier: Number(team.score.multiplier), finalScore: Number(team.score.finalScore) } : null
    })) });
  } catch (error) {
    next(error);
  }
};

const listBids = async (req, res, next) => {
  try {
    const rounds = await getRoundDefinitions(await gameService.getOrCreateGameConfig());
    const requested = req.query?.round;
    if (requested !== undefined && (!isIntegerInput(requested) || Number(requested) < 1))
      throw new ApiError(400, 'round must be a positive integer');
    const target = requested !== undefined ? rounds.find((round) => round.roundNumber === Number(requested)) : null;
    const bids = requested !== undefined && !target ? [] : await prisma.bid.findMany({
      ...(target ? { where: { promptId: target.promptId } } : {}),
      include: { prompt: true, team: { select: { teamName: true } } },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }]
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, rounds,
      bids: bids.map(({ team, ...bid }) => ({ ...promptRound(bid, rounds), teamName: team.teamName })) });
  } catch (error) { next(error); }
};

const createTeam = async (req, res, next) => {
  try {
    const { teamName, password } = req.body || {};

    const validation = validateTeamInput(teamName, password);
    if (!validation.isValid) throw new ApiError(400, validation.error);

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
      if (typeof teamName !== 'string' || teamName.trim().length < 2 || teamName.trim().length > 50) {
        throw new ApiError(400, 'Team name cannot be empty');
      }
      data.teamName = teamName.trim();
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 4 || Buffer.byteLength(password, 'utf8') > 72) {
        throw new ApiError(400, 'Password must be at least 4 characters long');
      }
      data.password = await hashPassword(password);
    }

    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') throw new ApiError(400, 'isActive must be a boolean');
      data.isActive = isActive;
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
  if (!isIntegerInput(id) || id <= 0) {
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
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }]
    });

    res.status(200).json({ success: true, prompts });
  } catch (error) {
    next(error);
  }
};

const createPrompt = async (req, res, next) => {
  try {
    const config = await gameService.getOrCreateGameConfig();
    const rounds = await getRoundDefinitions(config);
    if (config.currentRound > 0 && config.currentRound < rounds.length)
      throw new ApiError(400, 'Reset bidding before changing the round prompt order');
    if ([GAME_STATUS.BIDDING, GAME_STATUS.PAUSED].includes(config.status))
      throw new ApiError(400, 'Cannot change prompts while a round is in progress');
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
    const config = await gameService.getOrCreateGameConfig();
    const rounds = await getRoundDefinitions(config);
    if (config.currentRound > 0 && config.currentRound < rounds.length && req.body?.displayOrder !== undefined)
      throw new ApiError(400, 'Reset bidding before changing the round prompt order');
    if ([GAME_STATUS.BIDDING, GAME_STATUS.PAUSED].includes(config.status))
      throw new ApiError(400, 'Cannot change prompts while a round is in progress');
    const id = Number(req.params.id);
    await getPromptOrThrow(id);

    const { title, description, displayOrder } = req.body || {};

    if (!title && !description && displayOrder === undefined) {
      throw new ApiError(400, 'Nothing to update: provide title, description, or displayOrder');
    }

    const validation = validatePromptInput(
      title !== undefined ? title : 'valid title',
      description !== undefined ? description : 'valid description',
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
    const config = await gameService.getOrCreateGameConfig();
    const rounds = await getRoundDefinitions(config);
    if (config.currentRound > 0 && config.currentRound < rounds.length)
      throw new ApiError(400, 'Reset bidding before changing the round prompt order');
    if ([GAME_STATUS.BIDDING, GAME_STATUS.PAUSED].includes(config.status))
      throw new ApiError(400, 'Cannot change prompts while a round is in progress');
    const id = Number(req.params.id);
    await getPromptOrThrow(id);

    await prisma.$transaction([
      prisma.bid.deleteMany({ where: { promptId: id } }),
      prisma.score.deleteMany({ where: { team: { assignment: { promptId: id } } } }),
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
    const result = await gameService.pauseRound(req.auth?.adminId, req.body?.timerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const resumeRound = async (req, res, next) => {
  try {
    const result = await gameService.resumeRound(req.auth?.adminId, req.body?.timerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const extendRound = async (req, res, next) => {
  try {
    const { extraSeconds, seconds } = req.body || {};
    const extra = extraSeconds !== undefined ? extraSeconds : seconds;
    const result = await gameService.extendRound(extra, req.auth?.adminId, req.body?.timerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const nextPrompt = async (req, res, next) => {
  try {
    const result = await gameService.nextPrompt(req.auth?.adminId, req.body?.timerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const endRound = async (req, res, next) => {
  try {
    const result = await gameService.endRound(req.auth?.adminId, req.body?.timerId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const rerunRound = async (req, res, next) => {
  try {
    const { round, roundNumber } = req.body || {};
    const paramRound = req.params?.round;
    const queryRound = req.query?.round ?? req.query?.roundNumber;
    const targetRound = round !== undefined ? round : roundNumber !== undefined ? roundNumber : (paramRound !== undefined ? paramRound : queryRound);
    const result = await gameService.rerunRound(targetRound, req.auth?.adminId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const resetGame = async (req, res, next) => {
  try {
    const { wipeTeams, wipePrompts, wipeAll } = req.body || {};

    for (const [name, value] of Object.entries({ wipeTeams, wipePrompts, wipeAll })) {
      if (value !== undefined && typeof value !== 'boolean') throw new ApiError(400, `${name} must be a boolean`);
    }
    await prisma.$transaction([
      prisma.bid.deleteMany(),
      prisma.score.deleteMany(),
      prisma.assignment.deleteMany(),
      ...((wipeTeams || wipeAll) ? [prisma.team.deleteMany()] : []),
      ...((wipePrompts || wipeAll) ? [prisma.prompt.deleteMany()] : []),
      prisma.gameConfig.updateMany({ data: {
        currentRound: 0, currentPromptIndex: -1, status: GAME_STATUS.WAITING, biddingState: {}
      } }),
      prisma.adminLog.create({ data: {
        adminId: req.auth?.adminId || null, action: 'RESET',
        details: `Game state reset to initial waiting state${wipeAll ? ' (all teams and prompts wiped)' : ''}`
      } })
    ]);
    timerManager.resetTimer();

    await gameService.publishState(await gameService.getOrCreateGameConfig());
    broadcast('game:reset', {});
    broadcast('leaderboard:update', {});

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

const controllers = {
  listBids,
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
  rerunRound,
  submitScore: scoreController.submitScore,
  getLeaderboard: scoreController.getLeaderboard,
  resetGame,
  getConfig,
  updateConfig
};

for (const name of ['createTeam', 'updateTeam', 'deleteTeam', 'toggleTeam',
  'createPrompt', 'updatePrompt', 'deletePrompt', 'resetGame', 'updateConfig']) {
  const handler = controllers[name];
  controllers[name] = (req, res, next) => withGameLock(async () => {
    let failed = false;
    await handler(req, res, (error) => { failed = true; next(error); });
    if (!failed) {
      broadcast('config:updated', {});
      broadcast('leaderboard:update', {});
      // Notifications do not hold the mutation queue for more database reads.
      broadcast('game:refresh', {});
    }
  }).catch(next);
}
module.exports = controllers;
