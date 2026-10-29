const prisma = require('../config/prisma');

// Round numbers identify prompts in the order captured when bidding starts.
const getRoundDefinitions = async (config) => {
  let ids = config?.biddingState?.promptIds;
  if (!Array.isArray(ids) || !ids.length) {
    const prompts = await prisma.prompt.findMany({ orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });
    ids = prompts.map((prompt) => prompt.id);
  }
  return ids.map((promptId, index) => ({ roundNumber: index + 1, promptId }));
};
const promptRound = (record, rounds) => record ? {
  ...record, round: rounds.find((round) => round.promptId === record.promptId)?.roundNumber ?? record.round
} : null;
const getBidRound = (config) => config.biddingState?.bidRound ?? config.currentRound;

// Preserve existing bids: a running auction from the old pass-based flow keeps
// its storage key, while its public round becomes the active prompt's position.
const normalizeLegacyConfig = async (config) => {
  if (!config || !config.currentRound || config.currentPromptIndex < 0 || config.biddingState?.flowVersion === 2) return config;
  const rounds = await getRoundDefinitions(null);
  const legacy = config.biddingState || {};
  const promptId = legacy.timer?.promptId ?? legacy.promptIds?.[config.currentPromptIndex] ?? rounds[config.currentPromptIndex]?.promptId;
  const current = rounds.find((round) => round.promptId === promptId);
  if (!current) return config;
  return { ...config, currentRound: current.roundNumber, currentPromptIndex: current.roundNumber - 1,
    biddingState: { ...legacy, flowVersion: 2, bidRound: config.currentRound, promptIds: rounds.map((round) => round.promptId) }
  };
};
module.exports = { getRoundDefinitions, promptRound, getBidRound, normalizeLegacyConfig };
