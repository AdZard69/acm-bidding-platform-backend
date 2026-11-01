const prisma = require('../config/prisma');

// A round is a complete pass through the captured prompt order.
const getPromptIds = async (config) => {
  const saved = config?.biddingState?.promptIds;
  if (Array.isArray(saved) && saved.length) return saved;
  return (await prisma.prompt.findMany({ orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] })).map((prompt) => prompt.id);
};
const getRoundDefinitions = async (config) => {
  const promptIds = await getPromptIds(config);
  return Array.from({ length: Math.max(1, config?.currentRound || 0, config?.biddingState?.highestRound || 0) },
    (_, index) => ({ roundNumber: index + 1, promptIds }));
};
// Version 2 used the prompt position as its database round. Keep those storage
// keys intact, reserving higher keys for new passes without colliding with bids.
const storageRound = (config, round, promptIndex) => config.biddingState?.legacyPromptRounds
  ? round === 1 ? promptIndex + 1 : config.biddingState.promptIds.length + round - 1
  : round;
const publicRound = (record, config) => record ? { ...record,
  round: config?.biddingState?.legacyPromptRounds
    ? record.round <= config.biddingState.promptIds.length ? 1 : record.round - config.biddingState.promptIds.length + 1
    : record.round
} : null;
const getBidRound = (config) => config.biddingState?.bidRound ?? storageRound(config, config.currentRound, config.currentPromptIndex);

const normalizeLegacyConfig = async (config) => {
  if (!config?.currentRound || config.biddingState?.flowVersion === 3) return config;
  const legacy = config.biddingState || {};
  // Early v2 prompt-based sessions saved bidRound. The newer two-pass v2
  // flow did not; retain its actual round rather than converting Round 2 to 1.
  const promptBased = legacy.flowVersion === 2 && legacy.bidRound != null;
  const savedPromptIds = await getPromptIds(config);
  const promptIds = promptBased ? savedPromptIds : await getPromptIds(null);
  const currentRound = promptBased ? 1 : config.currentRound;
  const activePromptId = legacy.timer?.promptId ?? savedPromptIds[config.currentPromptIndex];
  const currentPromptIndex = promptIds.indexOf(activePromptId) >= 0 ? promptIds.indexOf(activePromptId) : config.currentPromptIndex;
  const openedCurrent = (promptBased && Array.isArray(legacy.openedRounds)
    ? legacy.openedRounds.map((round) => promptIds[round - 1]).filter((id) => id != null)
    : savedPromptIds.slice(0, config.currentPromptIndex + 1)).map((id) => `${currentRound}:${id}`);
  const openedPrevious = currentRound === 2 ? promptIds.map((id) => `1:${id}`) : [];
  return { ...config, currentRound, currentPromptIndex, biddingState: {
    ...legacy, flowVersion: 3, legacyPromptRounds: promptBased,
    bidRound: legacy.bidRound ?? config.currentRound, promptIds, highestRound: currentRound,
    openedPrompts: [...openedPrevious, ...openedCurrent]
  } };
};
module.exports = { getPromptIds, getRoundDefinitions, publicRound, storageRound, getBidRound, normalizeLegacyConfig };
