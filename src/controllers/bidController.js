const prisma = require('../config/prisma');
const ApiError = require('../utils/apiError');
const { validateBid } = require('../utils/validators');
const gameService = require('../services/gameService');
const timerManager = require('../socket/timerManager');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const { broadcast } = require('../socket');
const scoreController = require('./scoreController');

/**
 * Validates team existence and active status.
 * Throws 404 if not found, 403 if deactivated, 400 if already assigned.
 */
const getActiveTeamForBiddingOrThrow = async (teamId) => {
  if (!Number.isInteger(teamId) || teamId <= 0) {
    throw new ApiError(400, 'Invalid team id');
  }

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { assignment: true }
  });

  if (!team) {
    throw new ApiError(404, 'Team not found');
  }

  if (!team.isActive) {
    throw new ApiError(403, 'This team has been deactivated. Speak to the admin.');
  }

  if (team.assignment) {
    throw new ApiError(400, 'Your team has already been assigned a prompt');
  }

  return team;
};

/**
 * Validates bidding state and returns { config, currentPrompt }
 */
const getActiveBiddingContextOrThrow = async () => {
  const config = await gameService.getOrCreateGameConfig();

  if (config.status === GAME_STATUS.PAUSED) {
    throw new ApiError(400, 'Round is currently paused');
  }

  if (config.status !== GAME_STATUS.BIDDING) {
    throw new ApiError(400, 'Bidding is not currently active');
  }

  const eligiblePrompts = await gameService.getEligiblePromptsForRound(
    config.currentRound,
    config.slotsPerPrompt
  );
  const currentPrompt = eligiblePrompts[config.currentPromptIndex];

  if (!currentPrompt) {
    throw new ApiError(400, 'No active prompt currently available for bidding');
  }

  return { config, currentPrompt };
};

/**
 * Internal logic for placing a bid
 */
const placeBidInternal = async (teamId, rawBidMinutes) => {
  const team = await getActiveTeamForBiddingOrThrow(teamId);
  const { config, currentPrompt } = await getActiveBiddingContextOrThrow();

  const validation = validateBid(rawBidMinutes, config.minBid, config.baseTime);
  if (!validation.isValid) {
    throw new ApiError(400, validation.error);
  }
  const bidMinutes = validation.value;

  // Check if team already bid on this prompt in this round
  const existingTeamBid = await prisma.bid.findUnique({
    where: {
      teamId_promptId_round: {
        teamId: team.id,
        promptId: currentPrompt.id,
        round: config.currentRound
      }
    }
  });

  if (existingTeamBid) {
    throw new ApiError(400, 'Team has already placed a bid for this prompt. Use update bid instead.');
  }

  // Check collision constraint: no duplicate bid minutes on the same prompt and round
  const collision = await prisma.bid.findUnique({
    where: {
      promptId_bidMinutes_round: {
        promptId: currentPrompt.id,
        bidMinutes,
        round: config.currentRound
      }
    }
  });

  if (collision) {
    throw new ApiError(409, `A bid of ${bidMinutes} minutes has already been placed by another team`);
  }

  let createdBid;
  try {
    createdBid = await prisma.bid.create({
      data: {
        teamId: team.id,
        promptId: currentPrompt.id,
        bidMinutes,
        round: config.currentRound
      }
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw new ApiError(409, `A bid of ${bidMinutes} minutes has already been placed by another team`);
    }
    throw err;
  }

  broadcast(SOCKET_EVENTS.SERVER.BID_NEW, {
    teamId: team.id,
    teamName: team.teamName,
    bidMinutes,
    promptId: currentPrompt.id
  });

  return {
    success: true,
    message: 'Bid placed successfully',
    bid: {
      id: createdBid.id,
      teamId: team.id,
      teamName: team.teamName,
      promptId: currentPrompt.id,
      bidMinutes,
      round: config.currentRound,
      submittedAt: createdBid.submittedAt
    }
  };
};

/**
 * Internal logic for updating an existing bid
 */
const updateBidInternal = async (teamId, rawBidMinutes) => {
  const team = await getActiveTeamForBiddingOrThrow(teamId);
  const { config, currentPrompt } = await getActiveBiddingContextOrThrow();

  const validation = validateBid(rawBidMinutes, config.minBid, config.baseTime);
  if (!validation.isValid) {
    throw new ApiError(400, validation.error);
  }
  const bidMinutes = validation.value;

  const existingBid = await prisma.bid.findUnique({
    where: {
      teamId_promptId_round: {
        teamId: team.id,
        promptId: currentPrompt.id,
        round: config.currentRound
      }
    }
  });

  if (!existingBid) {
    throw new ApiError(404, 'No existing bid found to update for this prompt');
  }

  if (existingBid.bidMinutes === bidMinutes) {
    throw new ApiError(400, 'New bid must be different from current bid');
  }

  const collision = await prisma.bid.findFirst({
    where: {
      promptId: currentPrompt.id,
      round: config.currentRound,
      bidMinutes,
      teamId: { not: team.id }
    }
  });

  if (collision) {
    throw new ApiError(409, `A bid of ${bidMinutes} minutes has already been placed by another team`);
  }

  let updatedBid;
  try {
    updatedBid = await prisma.bid.update({
      where: { id: existingBid.id },
      data: {
        bidMinutes,
        submittedAt: new Date()
      }
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw new ApiError(409, `A bid of ${bidMinutes} minutes has already been placed by another team`);
    }
    throw err;
  }

  broadcast(SOCKET_EVENTS.SERVER.BID_UPDATED, {
    teamId: team.id,
    teamName: team.teamName,
    bidMinutes,
    promptId: currentPrompt.id
  });

  return {
    success: true,
    message: 'Bid updated successfully',
    bid: {
      id: updatedBid.id,
      teamId: team.id,
      teamName: team.teamName,
      promptId: currentPrompt.id,
      bidMinutes,
      round: config.currentRound,
      submittedAt: updatedBid.submittedAt
    }
  };
};

/**
 * POST /api/bid/place
 */
const placeBid = async (req, res, next) => {
  try {
    const rawBid = req.body?.bidMinutes !== undefined ? req.body.bidMinutes : req.body?.bid;
    const result = await placeBidInternal(req.auth.teamId, rawBid);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/bid/update
 */
const updateBid = async (req, res, next) => {
  try {
    const rawBid = req.body?.bidMinutes !== undefined ? req.body.bidMinutes : req.body?.bid;
    const result = await updateBidInternal(req.auth.teamId, rawBid);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/bid/current
 */
const getCurrentPrompt = async (req, res, next) => {
  try {
    const teamId = req.auth.teamId;
    const config = await gameService.getOrCreateGameConfig();

    let currentPrompt = null;
    let bids = [];
    let myBid = null;

    if (config.status === GAME_STATUS.BIDDING || config.status === GAME_STATUS.PAUSED) {
      const eligiblePrompts = await gameService.getEligiblePromptsForRound(
        config.currentRound,
        config.slotsPerPrompt
      );
      currentPrompt = eligiblePrompts[config.currentPromptIndex] || null;

      if (currentPrompt) {
        const promptBids = await prisma.bid.findMany({
          where: {
            promptId: currentPrompt.id,
            round: config.currentRound
          },
          include: {
            team: {
              select: { id: true, teamName: true }
            }
          },
          orderBy: { bidMinutes: 'asc' }
        });

        bids = promptBids.map((b) => ({
          teamId: b.teamId,
          teamName: b.team.teamName,
          bidMinutes: b.bidMinutes,
          submittedAt: b.submittedAt
        }));

        const foundMyBid = promptBids.find((b) => b.teamId === teamId);
        if (foundMyBid) {
          myBid = {
            id: foundMyBid.id,
            bidMinutes: foundMyBid.bidMinutes,
            submittedAt: foundMyBid.submittedAt
          };
        }
      }
    }

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        assignment: {
          include: { prompt: true }
        }
      }
    });

    res.status(200).json({
      success: true,
      status: config.status,
      currentRound: config.currentRound,
      currentPrompt: currentPrompt
        ? {
            id: currentPrompt.id,
            title: currentPrompt.title,
            description: currentPrompt.description,
            displayOrder: currentPrompt.displayOrder
          }
        : null,
      secondsRemaining: timerManager.getSecondsRemaining(),
      isPaused: timerManager.isTimerPaused(),
      bids,
      myBid,
      hasAssignment: Boolean(team?.assignment),
      assignment: team?.assignment
        ? {
            promptId: team.assignment.promptId,
            title: team.assignment.prompt.title,
            bidMinutes: team.assignment.bidMinutes,
            multiplier: Number(team.assignment.multiplier)
          }
        : null
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/bid/my-bids
 */
const getMyBids = async (req, res, next) => {
  try {
    const teamId = req.auth.teamId;

    const bids = await prisma.bid.findMany({
      where: { teamId },
      include: {
        prompt: {
          select: {
            id: true,
            title: true,
            displayOrder: true
          }
        }
      },
      orderBy: [
        { round: 'asc' },
        { submittedAt: 'asc' }
      ]
    });

    const formattedBids = bids.map((b) => ({
      id: b.id,
      promptId: b.promptId,
      promptTitle: b.prompt.title,
      displayOrder: b.prompt.displayOrder,
      round: b.round,
      bidMinutes: b.bidMinutes,
      submittedAt: b.submittedAt
    }));

    res.status(200).json({
      success: true,
      bids: formattedBids
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/bid/assignment
 */
const getAssignment = async (req, res, next) => {
  try {
    const teamId = req.auth.teamId;

    const assignment = await prisma.assignment.findUnique({
      where: { teamId },
      include: { prompt: true }
    });

    if (!assignment) {
      return res.status(200).json({
        success: true,
        assignment: null,
        message: 'No prompt assigned yet'
      });
    }

    res.status(200).json({
      success: true,
      assignment: {
        id: assignment.id,
        teamId: assignment.teamId,
        promptId: assignment.promptId,
        title: assignment.prompt.title,
        description: assignment.prompt.description,
        displayOrder: assignment.prompt.displayOrder,
        bidMinutes: assignment.bidMinutes,
        round: assignment.round,
        multiplier: Number(assignment.multiplier),
        codingTimeMinutes: assignment.bidMinutes,
        assignedAt: assignment.assignedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/bid/leaderboard
 */
const getLeaderboard = async (req, res, next) => {
  return scoreController.getLeaderboard(req, res, next);
};

module.exports = {
  placeBid,
  updateBid,
  getCurrentPrompt,
  getMyBids,
  getAssignment,
  getLeaderboard,
  placeBidInternal,
  updateBidInternal
};
