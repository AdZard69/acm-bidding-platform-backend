/**
 * Multiplier Service
 * Implements exponential multiplying factor based on time commitment:
 * Formula: multiplier = e ^ (k * (1 - bid / base_time))
 *
 * Round 1: k = 1.0  (range ~1.000 to ~2.117)
 * Round 2: k = 0.7  (range ~1.000 to ~1.690)
 */

const DEFAULT_BASE_TIME = 120;
const DEFAULT_MIN_BID = 30;

const K_FACTORS = Object.freeze({
  1: 1.0,
  2: 0.7
});

/**
 * Get k-factor for a given round
 * @param {number} round - 1 or 2
 * @returns {number}
 */
const getKFactor = (round = 1) => {
  return K_FACTORS[round] !== undefined ? K_FACTORS[round] : 1.0;
};

/**
 * Calculates multiplier for a given bid and round
 * @param {number} bidMinutes - Bid in minutes (e.g. 20 to 100)
 * @param {number} round - Round number (1 or 2)
 * @param {number} baseTime - Base reference time (default 100)
 * @param {number} minBid - Minimum allowed bid (default 20)
 * @returns {number} - Multiplier rounded to 3 decimal places
 */
const calculateMultiplier = (
  bidMinutes,
  round = 1,
  baseTime = DEFAULT_BASE_TIME,
  minBid = DEFAULT_MIN_BID
) => {
  const numericBid = Number(bidMinutes);
  if (isNaN(numericBid)) {
    throw new Error('Bid minutes must be a valid number');
  }

  // Clamp bid within allowable bounds [minBid, baseTime]
  const clampedBid = Math.max(minBid, Math.min(baseTime, numericBid));
  const k = getKFactor(round);

  const exponent = k * (1 - clampedBid / baseTime);
  const rawMultiplier = Math.exp(exponent);

  // Round to 3 decimal places matching DB schema Decimal(5, 3)
  return Math.round(rawMultiplier * 1000) / 1000;
};

/**
 * Computes final multiplied score from judge evaluation
 * Final Score = judge_score * multiplier
 * @param {number} judgeScore - Score between 0 and 100
 * @param {number} multiplier - Multiplier factor
 * @returns {number} - Final score rounded to 3 decimal places
 */
const calculateFinalScore = (judgeScore, multiplier) => {
  const numericScore = Number(judgeScore);
  const numericMultiplier = Number(multiplier);

  if (isNaN(numericScore) || isNaN(numericMultiplier)) {
    throw new Error('Judge score and multiplier must be valid numbers');
  }

  const rawFinalScore = numericScore * numericMultiplier;
  return Math.round(rawFinalScore * 1000) / 1000;
};

/**
 * Helper to generate a lookup table for display/reference
 * @param {number} round
 * @param {number} step
 * @returns {Array<{ bid: number, multiplier: number }>}
 */
const generateMultiplierTable = (round = 1, step = 10) => {
  const table = [];
  for (let bid = DEFAULT_BASE_TIME; bid >= DEFAULT_MIN_BID; bid -= step) {
    table.push({
      bid,
      multiplier: calculateMultiplier(bid, round)
    });
  }
  return table;
};

module.exports = {
  K_FACTORS,
  getKFactor,
  calculateMultiplier,
  calculateFinalScore,
  generateMultiplierTable
};
