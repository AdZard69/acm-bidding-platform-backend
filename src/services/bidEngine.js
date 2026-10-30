const prisma = require('../config/prisma');
const { calculateMultiplier } = require('./multiplierService');
const logger = require('../utils/logger');
const { sendToTeam } = require('../socket/emitter');
const { getBidRound, getRoundDefinitions } = require('./roundService');

/**
 * Evaluates bids for a specific prompt and round, selects winners,
 * calculates multipliers, and creates assignments in the database.
 *
 * @param {number} promptId
 * @param {number} round - 1 or 2
 * @param {number} availableSlots - Number of slots open for this prompt
 * @param {object} config - GameConfig object { baseTime, minBid }
 * @returns {Promise<Array<{ teamId: number, teamName: string, bidMinutes: number, multiplier: number }>>}
 */
const evaluatePromptBids = async (promptId, round, availableSlots, config) => {
  if (availableSlots <= 0) {
    return [];
  }

  // Find all bids for this prompt and round by teams that do NOT yet have an assignment and are active
  const eligibleBids = await prisma.bid.findMany({
    where: {
      promptId,
      round: getBidRound(config),
      team: {
        isActive: true,
        assignment: null
      }
    },
    include: {
      team: {
        select: { id: true, teamName: true }
      }
    },
    orderBy: [
      { bidMinutes: 'asc' },
      { submittedAt: 'asc' }
    ],
    take: availableSlots
  });

  if (eligibleBids.length === 0) {
    return [];
  }

  const baseTime = config?.baseTime || 120;
  const minBid = config?.minBid || 30;
  const winners = [];

  for (const bid of eligibleBids) {
    const multiplier = calculateMultiplier(bid.bidMinutes, round, baseTime, minBid);

    const assignment = await prisma.assignment.create({
      data: {
        teamId: bid.teamId,
        promptId: promptId,
        bidMinutes: bid.bidMinutes,
        round: round,
        multiplier: multiplier
      }
    });

    winners.push({
      teamId: bid.teamId,
      teamName: bid.team.teamName,
      bidMinutes: bid.bidMinutes,
      multiplier: Number(assignment.multiplier)
    });
  }

  logger.info(`Prompt ${promptId} evaluated for round ${round}. Winners: ${winners.length}`);
  return winners;
};

/**
 * Handles edge case: if only 1 unassigned team remains at the end of bidding,
 * auto-assigns the team to a prompt that still has open slots at base time (multiplier 1.0).
 *
 * @param {number} teamId
 * @param {object} config
 * @returns {Promise<object|null>}
 */
const autoAssignRemainingTeam = async (teamId, config) => {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { assignment: true }
  });

  if (!team || !team.isActive || team.assignment) {
    return null;
  }

  const prompts = await prisma.prompt.findMany({
    orderBy: { displayOrder: 'asc' },
    include: { assignments: true }
  });

  const slotsPerPrompt = config?.slotsPerPrompt || 3;
  const baseTime = config?.baseTime || 120;
  const rounds = await getRoundDefinitions(config);

  const eligiblePrompt = prompts.find((p) => p.assignments.length < slotsPerPrompt);
  if (!eligiblePrompt) {
    return null;
  }

  const round = rounds.find((entry) => entry.promptId === eligiblePrompt.id)?.roundNumber || config.currentRound;
  const assignment = await prisma.assignment.create({
    data: {
      teamId: team.id,
      promptId: eligiblePrompt.id,
      bidMinutes: baseTime,
      round: round,
      multiplier: 1.000
    }
  });

  logger.info(`Auto-assigned team ${team.teamName} (id ${team.id}) to prompt ${eligiblePrompt.id} at base time`);

  sendToTeam(team.id, 'assignment:received', {
    promptId: eligiblePrompt.id, title: eligiblePrompt.title, description: eligiblePrompt.description,
    bidMinutes: baseTime, multiplier: 1, codingTimeMinutes: baseTime, round
  });

  return {
    teamId: team.id,
    teamName: team.teamName,
    promptId: eligiblePrompt.id,
    bidMinutes: baseTime,
    multiplier: 1.000
  };
};

module.exports = {
  evaluatePromptBids,
  autoAssignRemainingTeam
};
