const prisma = require('../config/prisma');
const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');
const GAME_STATUS = require('../constants/gameStatus');
const SOCKET_EVENTS = require('../constants/socketEvents');
const { broadcast } = require('../socket/emitter');
const { getOrCreateGameConfig, getCurrentBiddingState } = require('./gameService');
const { outsideOperation } = require('../utils/operation');

const GITHUB_URL_REGEX = /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.*)?$/;

const validateGithubUrl = (url) => {
  if (!url || typeof url !== 'string') {
    throw new ApiError(400, 'GitHub URL is required and must be a string');
  }
  const trimmed = url.trim();
  if (!GITHUB_URL_REGEX.test(trimmed)) {
    throw new ApiError(400, 'Invalid GitHub URL. Must be in the format: https://github.com/username/repository');
  }
  return trimmed;
};

const logAction = async (adminId, action, details) => {
  try {
    return await prisma.adminLog.create({ data: { adminId, action, details } });
  } catch (error) {
    logger.warn(`Audit log for ${action} could not be saved (${error.code || error.name})`);
    return null;
  }
};

/**
 * Start coding timers for all assigned teams.
 */
const startCodingTimers = async (adminId = null) => {
  const config = await getOrCreateGameConfig();

  const assignedTeamsCount = await prisma.assignment.count();
  if (assignedTeamsCount === 0) {
    logger.warn('Starting coding phase without any assigned teams yet');
  }

  const now = Date.now();
  const coding = {
    startTime: now,
    isPaused: false,
    pausedAt: null
  };

  const updated = await prisma.gameConfig.update({
    where: { id: config.id },
    data: {
      status: GAME_STATUS.CODING,
      biddingState: {
        ...(config.biddingState || {}),
        coding
      }
    }
  });

  const state = await getCurrentBiddingState();
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, state);
  broadcast(SOCKET_EVENTS.SERVER.CODING_STARTED, {
    status: GAME_STATUS.CODING,
    startTime: now,
    coding
  });

  void outsideOperation(() => logAction(adminId, 'START_CODING', `Started coding timers for ${assignedTeamsCount} teams`));

  return {
    success: true,
    message: 'Coding timers started for all teams',
    status: GAME_STATUS.CODING,
    coding
  };
};

/**
 * Pause coding timers.
 */
const pauseCodingTimers = async (adminId = null) => {
  const config = await getOrCreateGameConfig();
  const coding = config.biddingState?.coding;

  if (!coding?.startTime) {
    throw new ApiError(400, 'Coding phase is not active');
  }
  if (coding.isPaused) {
    throw new ApiError(400, 'Coding timers are already paused');
  }

  const now = Date.now();
  const updatedCoding = {
    ...coding,
    isPaused: true,
    pausedAt: now
  };

  await prisma.gameConfig.update({
    where: { id: config.id },
    data: {
      biddingState: {
        ...(config.biddingState || {}),
        coding: updatedCoding
      }
    }
  });

  const state = await getCurrentBiddingState();
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, state);
  broadcast(SOCKET_EVENTS.SERVER.CODING_PAUSED, {
    status: config.status,
    coding: updatedCoding
  });

  void outsideOperation(() => logAction(adminId, 'PAUSE_CODING', 'Paused coding timers'));

  return {
    success: true,
    message: 'Coding timers paused',
    coding: updatedCoding
  };
};

/**
 * Resume coding timers.
 */
const resumeCodingTimers = async (adminId = null) => {
  const config = await getOrCreateGameConfig();
  const coding = config.biddingState?.coding;

  if (!coding?.startTime) {
    throw new ApiError(400, 'Coding phase is not active');
  }
  if (!coding.isPaused) {
    throw new ApiError(400, 'Coding timers are not paused');
  }

  const now = Date.now();
  const pauseDuration = coding.pausedAt ? (now - coding.pausedAt) : 0;
  const updatedCoding = {
    ...coding,
    startTime: coding.startTime + pauseDuration,
    isPaused: false,
    pausedAt: null
  };

  await prisma.gameConfig.update({
    where: { id: config.id },
    data: {
      status: GAME_STATUS.CODING,
      biddingState: {
        ...(config.biddingState || {}),
        coding: updatedCoding
      }
    }
  });

  const state = await getCurrentBiddingState();
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, state);
  broadcast(SOCKET_EVENTS.SERVER.CODING_RESUMED, {
    status: GAME_STATUS.CODING,
    coding: updatedCoding
  });

  void outsideOperation(() => logAction(adminId, 'RESUME_CODING', 'Resumed coding timers'));

  return {
    success: true,
    message: 'Coding timers resumed',
    coding: updatedCoding
  };
};

/**
 * Reset coding timers.
 */
const resetCodingTimers = async (adminId = null, wipeSubmissions = false) => {
  const config = await getOrCreateGameConfig();

  const nextBiddingState = { ...(config.biddingState || {}) };
  delete nextBiddingState.coding;

  await prisma.gameConfig.update({
    where: { id: config.id },
    data: {
      status: config.currentRound > 0 ? GAME_STATUS.ROUND_ENDED : GAME_STATUS.WAITING,
      biddingState: nextBiddingState
    }
  });

  if (wipeSubmissions) {
    await prisma.submission.deleteMany();
  }

  const state = await getCurrentBiddingState();
  broadcast(SOCKET_EVENTS.SERVER.GAME_STATUS, state);
  broadcast(SOCKET_EVENTS.SERVER.CODING_RESET, {
    status: config.currentRound > 0 ? GAME_STATUS.ROUND_ENDED : GAME_STATUS.WAITING
  });

  void outsideOperation(() => logAction(adminId, 'RESET_CODING', `Reset coding timers${wipeSubmissions ? ' and wiped submissions' : ''}`));

  return {
    success: true,
    message: 'Coding timers reset successfully'
  };
};

/**
 * Submit project (GitHub URL) for a team.
 */
const submitProject = async (teamId, rawGithubUrl) => {
  const cleanUrl = validateGithubUrl(rawGithubUrl);

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { assignment: { include: { prompt: true } } }
  });

  if (!team) {
    throw new ApiError(404, 'Team not found');
  }
  if (!team.assignment) {
    throw new ApiError(400, 'Your team does not have an assigned problem statement yet.');
  }

  const config = await getOrCreateGameConfig();
  const coding = config.biddingState?.coding;

  if (!coding?.startTime) {
    throw new ApiError(400, 'Coding phase has not started yet. Submissions are not open.');
  }

  if (coding.isPaused) {
    throw new ApiError(400, 'Coding phase is currently paused. Please wait for organizers to resume.');
  }

  const bidMinutes = team.assignment.bidMinutes;
  const deadline = coding.startTime + bidMinutes * 60 * 1000;
  const gracePeriodMs = 30000; // 30-second network grace period
  const now = Date.now();

  if (now > deadline + gracePeriodMs) {
    throw new ApiError(400, `Coding time expired! Your committed time limit was ${bidMinutes} minutes and the submission deadline has passed.`);
  }

  const submission = await prisma.submission.upsert({
    where: { teamId },
    update: {
      githubUrl: cleanUrl,
      updatedAt: new Date()
    },
    create: {
      teamId,
      githubUrl: cleanUrl
    }
  });

  broadcast(SOCKET_EVENTS.SERVER.SUBMISSION_UPDATED, {
    teamId,
    teamName: team.teamName,
    githubUrl: submission.githubUrl,
    submittedAt: submission.submittedAt,
    updatedAt: submission.updatedAt,
    bidMinutes,
    promptTitle: team.assignment.prompt?.title,
    promptId: team.assignment.promptId
  });

  logger.info(`Team "${team.teamName}" (id ${teamId}) submitted project: ${cleanUrl}`);

  return {
    success: true,
    message: 'Project submitted successfully!',
    submission,
    deadline,
    remainingSeconds: Math.max(0, Math.ceil((deadline - now) / 1000))
  };
};

/**
 * Get current team's submission details & coding status.
 */
const getMySubmission = async (teamId) => {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: {
      assignment: { include: { prompt: true } },
      submission: true
    }
  });

  if (!team) {
    throw new ApiError(404, 'Team not found');
  }

  const config = await getOrCreateGameConfig();
  const coding = config.biddingState?.coding;
  const now = Date.now();

  let deadline = null;
  let remainingSeconds = 0;
  let isExpired = false;

  if (coding?.startTime && team.assignment) {
    const allocatedMs = team.assignment.bidMinutes * 60 * 1000;
    deadline = coding.startTime + allocatedMs;
    remainingSeconds = Math.max(0, Math.ceil((deadline - now) / 1000));
    isExpired = now > deadline;
  }

  return {
    success: true,
    submission: team.submission || null,
    assignment: team.assignment ? {
      promptId: team.assignment.promptId,
      promptTitle: team.assignment.prompt?.title,
      description: team.assignment.prompt?.description,
      bidMinutes: team.assignment.bidMinutes,
      round: team.assignment.round,
      multiplier: Number(team.assignment.multiplier)
    } : null,
    codingState: {
      gameStatus: config.status,
      isStarted: Boolean(coding?.startTime),
      startTime: coding?.startTime || null,
      isPaused: Boolean(coding?.isPaused),
      deadline,
      remainingSeconds,
      isExpired
    }
  };
};

/**
 * List all submissions for admin view.
 */
const listAllSubmissions = async () => {
  const teams = await prisma.team.findMany({
    include: {
      assignment: { include: { prompt: true } },
      submission: true
    },
    orderBy: { id: 'asc' }
  });

  const config = await getOrCreateGameConfig();
  const coding = config.biddingState?.coding;
  const now = Date.now();

  const submissions = teams.map((team) => {
    let deadline = null;
    let remainingSeconds = 0;
    let isExpired = false;
    let isLate = false;

    if (coding?.startTime && team.assignment) {
      const allocatedMs = team.assignment.bidMinutes * 60 * 1000;
      deadline = coding.startTime + allocatedMs;
      remainingSeconds = Math.max(0, Math.ceil((deadline - now) / 1000));
      isExpired = now > deadline;
      if (team.submission) {
        const subTime = new Date(team.submission.submittedAt).getTime();
        isLate = subTime > deadline + 30000;
      }
    }

    return {
      teamId: team.id,
      teamName: team.teamName,
      assignment: team.assignment ? {
        promptId: team.assignment.promptId,
        promptTitle: team.assignment.prompt?.title,
        bidMinutes: team.assignment.bidMinutes,
        round: team.assignment.round,
        multiplier: Number(team.assignment.multiplier)
      } : null,
      submission: team.submission || null,
      deadline,
      remainingSeconds,
      isExpired,
      isSubmitted: Boolean(team.submission),
      isLate
    };
  });

  return {
    success: true,
    gameStatus: config.status,
    codingState: {
      isStarted: Boolean(coding?.startTime),
      startTime: coding?.startTime || null,
      isPaused: Boolean(coding?.isPaused)
    },
    submissions
  };
};

module.exports = {
  validateGithubUrl,
  startCodingTimers,
  pauseCodingTimers,
  resumeCodingTimers,
  resetCodingTimers,
  submitProject,
  getMySubmission,
  listAllSubmissions
};
