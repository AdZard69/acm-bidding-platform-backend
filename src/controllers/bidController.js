const prisma = require('../config/prisma');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');
const timerManager = require('../socket/timerManager');
const gameService = require('../services/gameService');
const { broadcast } = require('../socket');

/**
 * Returns current prompt, seconds left, and placed bids for that prompt
 */
const getCurrentBiddingState = async (req, res, next) => {
  try {
    const config = await gameService.getOrCreateGameConfig();

    let currentPrompt = null;
    let bids = [];
    const secondsRemaining = timerManager.secondsRemaining;

    if (config.currentPromptIndex >= 0 && (config.status === GAME_STATUS.BIDDING || config.status === GAME_STATUS.PAUSED)) {
      const eligiblePrompts = await gameService.getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
      currentPrompt = eligiblePrompts[config.currentPromptIndex] || null;

      if (currentPrompt) {
        bids = await prisma.bid.findMany({
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

        bids = bids.map((b) => ({
          teamId: b.teamId,
          teamName: b.team.teamName,
          bidMinutes: b.bidMinutes,
          promptId: b.promptId,
          round: b.round,
          submittedAt: b.submittedAt
        }));
      }
    }

    res.status(200).json({
      success: true,
      status: config.status,
      currentRound: config.currentRound,
      currentPrompt,
      secondsRemaining,
      bids
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Places a bid for the team on the active prompt
 */
const placeBid = async (req, res, next) => {
  try {
    const teamId = req.auth?.teamId;
    if (!teamId) {
      throw new ApiError(401, 'Team identity missing');
    }

    const { bidMinutes } = req.body;
    const minutes = Number(bidMinutes);
    if (!Number.isInteger(minutes) || isNaN(minutes)) {
      throw new ApiError(400, 'bidMinutes must be an integer');
    }

    const config = await gameService.getOrCreateGameConfig();
    if (config.status !== GAME_STATUS.BIDDING) {
      throw new ApiError(400, `Bidding is not open (current status: ${config.status})`);
    }

    if (minutes < config.minBid || minutes > config.baseTime) {
      throw new ApiError(400, `Bid must be between ${config.minBid} and ${config.baseTime} minutes`);
    }

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: { assignment: true }
    });

    if (!team || !team.isActive) {
      throw new ApiError(403, 'Team account is deactivated or not found');
    }

    if (team.assignment) {
      throw new ApiError(400, 'Team already has an assigned prompt');
    }

    const eligiblePrompts = await gameService.getEligiblePromptsForRound(config.currentRound, config.slotsPerPrompt);
    const currentPrompt = eligiblePrompts[config.currentPromptIndex];
    if (!currentPrompt) {
      throw new ApiError(400, 'No active prompt found');
    }

    // Check collision: no two teams can bid the same minutes on the same prompt in the same round
    const collision = await prisma.bid.findFirst({
      where: {
        promptId: currentPrompt.id,
        round: config.currentRound,
        bidMinutes: minutes,
        teamId: { not: teamId }
      }
    });

    if (collision) {
      throw new ApiError(409, `Another team has already bid ${minutes} minutes. Pick another value.`);
    }

    // Upsert or create bid
    const bid = await prisma.bid.upsert({
      where: {
        teamId_promptId_round: {
          teamId,
          promptId: currentPrompt.id,
          round: config.currentRound
        }
      },
      update: {
        bidMinutes: minutes,
        submittedAt: new Date()
      },
      create: {
        teamId,
        promptId: currentPrompt.id,
        round: config.currentRound,
        bidMinutes: minutes
      }
    });

    const bidData = {
      teamId: team.id,
      teamName: team.teamName,
      bidMinutes: minutes,
      promptId: currentPrompt.id,
      round: config.currentRound
    };

    broadcast(SOCKET_EVENTS.SERVER.BID_NEW, bidData);

    res.status(200).json({
      success: true,
      message: 'Bid placed successfully',
      bid: bidData
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Updates an existing bid
 */
const updateBid = async (req, res, next) => {
  return placeBid(req, res, next);
};

/**
 * Returns all bids placed by the calling team
 */
const getMyBids = async (req, res, next) => {
  try {
    const teamId = req.auth?.teamId;
    const bids = await prisma.bid.findMany({
      where: { teamId },
      include: { prompt: true },
      orderBy: { submittedAt: 'desc' }
    });
    res.status(200).json({ success: true, bids });
  } catch (err) {
    next(err);
  }
};

/**
 * Returns prompt assignment for calling team
 */
const getMyAssignment = async (req, res, next) => {
  try {
    const teamId = req.auth?.teamId;
    const assignment = await prisma.Assignment.findUnique({
      where: { teamId },
      include: { prompt: true }
    });
    res.status(200).json({ success: true, assignment });
  } catch (err) {
    next(err);
  }
};

/**
 * Public leaderboard
 */
const getLeaderboard = async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      where: { isActive: true },
      include: {
        assignment: { include: { prompt: true } },
        score: true
      }
    });

    const leaderboard = teams
      .map((t) => ({
        teamId: t.id,
        teamName: t.teamName,
        isActive: t.isActive,
        prompt: t.assignment?.prompt
          ? {
              id: t.assignment.prompt.id,
              title: t.assignment.prompt.title,
              displayOrder: t.assignment.prompt.displayOrder
            }
          : null,
        bidMinutes: t.assignment?.bidMinutes ?? null,
        multiplier: t.assignment?.multiplier ? Number(t.assignment.multiplier) : null,
        judgeScore: t.score?.judgeScore ?? null,
        finalScore: t.score?.finalScore ? Number(t.score.finalScore) : null,
        scoredAt: t.score?.scoredAt ?? null
      }))
      .sort((a, b) => {
        if (a.finalScore !== null && b.finalScore !== null) {
          return b.finalScore - a.finalScore;
        }
        if (a.finalScore !== null) return -1;
        if (b.finalScore !== null) return 1;
        if (a.multiplier !== null && b.multiplier !== null) {
          return b.multiplier - a.multiplier;
        }
        return 0;
      })
      .map((entry, index) => ({
        rank: index + 1,
        ...entry
      }));

    res.status(200).json({ success: true, leaderboard });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCurrentBiddingState,
  placeBid,
  updateBid,
  getMyBids,
  getMyAssignment,
  getLeaderboard
};
