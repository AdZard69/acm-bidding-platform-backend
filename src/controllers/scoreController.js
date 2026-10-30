const prisma = require('../config/prisma');
const ApiError = require('../utils/apiError');
const { validateScore, isIntegerInput } = require('../utils/validators');
const { calculateFinalScore } = require('../services/multiplierService');
const { sendToTeam, broadcast } = require('../socket/emitter');
const SOCKET_EVENTS = require('../constants/socketEvents');
const { withGameLock } = require('../services/gameLock');

/**
 * Submit or update a judge evaluation score for a team
 * POST /api/admin/scores/:teamId
 */
const submitScore = async (req, res, next) => {
  try {
    const teamId = Number(req.params.teamId);
    if (!isIntegerInput(teamId) || teamId <= 0) {
      throw new ApiError(400, 'Invalid team id');
    }

    const { judgeScore, score } = req.body || {};
    const inputScore = judgeScore !== undefined ? judgeScore : score;

    const validation = validateScore(inputScore);
    if (!validation.isValid) {
      throw new ApiError(400, validation.error);
    }
    const scoreVal = validation.value;

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      include: {
        assignment: true,
        score: true
      }
    });

    if (!team) {
      throw new ApiError(404, 'Team not found');
    }

    if (!team.assignment) {
      throw new ApiError(400, 'Cannot score team: team has not been assigned a prompt yet');
    }

    const multiplier = Number(team.assignment.multiplier);
    const finalScore = calculateFinalScore(scoreVal, multiplier);

    const isUpdate = !!team.score;

    const [savedScore] = await prisma.$transaction([prisma.score.upsert({
      where: { teamId },
      update: {
        judgeScore: scoreVal,
        multiplier,
        finalScore,
        scoredAt: new Date()
      },
      create: {
        teamId,
        judgeScore: scoreVal,
        multiplier,
        finalScore
      }
    }), prisma.adminLog.create({
      data: {
        adminId: req.auth?.adminId || null,
        action: isUpdate ? 'SCORE_OVERRIDE' : 'SUBMIT_SCORE',
        details: `${isUpdate ? 'Updated' : 'Submitted'} judge score ${scoreVal} for team "${team.teamName}" (multiplier: ${multiplier}, final: ${finalScore})`
      }
    })]);

    sendToTeam(teamId, SOCKET_EVENTS.SERVER.SCORE_RECEIVED, {
      id: savedScore.id,
      scoredAt: savedScore.scoredAt,
      teamId,
      judgeScore: scoreVal,
      multiplier,
      finalScore: Number(savedScore.finalScore)
    });

    broadcast('leaderboard:update', {
      teamId,
      teamName: team.teamName,
      judgeScore: scoreVal,
      multiplier,
      finalScore: Number(savedScore.finalScore)
    });

    res.status(200).json({
      success: true,
      message: isUpdate ? 'Score updated successfully' : 'Score submitted successfully',
      score: {
        id: savedScore.id,
        teamId: team.id,
        teamName: team.teamName,
        judgeScore: savedScore.judgeScore,
        multiplier: Number(savedScore.multiplier),
        finalScore: Number(savedScore.finalScore),
        scoredAt: savedScore.scoredAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieve the full leaderboard with rankings and final scores
 * GET /api/admin/leaderboard
 */
const getLeaderboard = async (req, res, next) => {
  try {
    const teams = await prisma.team.findMany({
      ...(req.publicLeaderboard ? { where: { isActive: true } } : {}),
      include: {
        assignment: {
          include: { prompt: true }
        },
        score: true
      }
    });

    // Scored teams first by finalScore DESC, then judgeScore DESC, then bidMinutes ASC
    const scoredTeams = teams
      .filter((t) => t.score !== null)
      .sort((a, b) => {
        const finalDiff = Number(b.score.finalScore) - Number(a.score.finalScore);
        if (finalDiff !== 0) return finalDiff;

        const judgeDiff = b.score.judgeScore - a.score.judgeScore;
        if (judgeDiff !== 0) return judgeDiff;

        const bidA = a.assignment?.bidMinutes ?? 999;
        const bidB = b.assignment?.bidMinutes ?? 999;
        return bidA - bidB;
      });

    const unscoredTeams = teams
      .filter((t) => t.score === null)
      .sort((a, b) => a.id - b.id);

    const sorted = [...scoredTeams, ...unscoredTeams];

    const leaderboard = sorted.map((t, index) => ({
      rank: index + 1,
      teamId: t.id,
      teamName: t.teamName,
      isActive: t.isActive,
      prompt: t.assignment ? {
        id: t.assignment.prompt.id,
        title: t.assignment.prompt.title,
        displayOrder: t.assignment.prompt.displayOrder
      } : null,
      bidMinutes: t.assignment ? t.assignment.bidMinutes : null,
      multiplier: t.assignment ? Number(t.assignment.multiplier) : null,
      judgeScore: t.score ? t.score.judgeScore : null,
      finalScore: t.score ? Number(t.score.finalScore) : null,
      scoredAt: t.score ? t.score.scoredAt : null
    }));

    res.status(200).json({
      success: true,
      leaderboard
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  submitScore: (req, res, next) => withGameLock(() => submitScore(req, res, next)).catch(next),
  getLeaderboard
};
