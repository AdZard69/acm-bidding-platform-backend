const prisma = require('../config/prisma');
const gameService = require('../services/gameService');
const { getRoundDefinitions, promptRound } = require('../services/roundService');

/**
 * Returns current prompt, seconds left, and placed bids for that prompt
 */
const getCurrentBiddingState = async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(await gameService.getCurrentBiddingState());
  } catch (err) { next(err); }
};

const placeBid = async (req, res, next) => {
  try {
    const { submitBid } = require('../services/bidService');
    res.status(200).json(await submitBid(req.auth?.teamId, req.body));
  } catch (err) { next(err); }
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
    const rounds = await getRoundDefinitions(await gameService.getOrCreateGameConfig());
    res.status(200).json({ success: true, bids: bids.map((bid) => promptRound(bid, rounds)) });
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
    const assignment = await prisma.assignment.findUnique({
      where: { teamId },
      include: { prompt: true }
    });
    const score = await prisma.score.findUnique({ where: { teamId } });
    const rounds = await getRoundDefinitions(await gameService.getOrCreateGameConfig());
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true,
      assignment: assignment ? { ...promptRound(assignment, rounds), multiplier: Number(assignment.multiplier) } : null,
      score: score ? { ...score, multiplier: Number(score.multiplier), finalScore: Number(score.finalScore) } : null
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Public leaderboard
 */
const getLeaderboard = (req, res, next) => {
  req.publicLeaderboard = true;
  return require('./scoreController').getLeaderboard(req, res, next);
};

module.exports = {
  getCurrentBiddingState,
  placeBid,
  updateBid,
  getMyBids,
  getMyAssignment,
  getLeaderboard
};
