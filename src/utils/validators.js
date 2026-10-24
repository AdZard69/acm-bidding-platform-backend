/**
 * Validation utilities for incoming requests and socket payloads
 */

/**
 * Validates a bid minute value
 * @param {any} bidMinutes
 * @param {number} minBid - Floor (default 30)
 * @param {number} baseTime - Ceiling (default 120)
 * @returns {{ isValid: boolean, error?: string, value?: number }}
 */
const validateBid = (bidMinutes, minBid = 30, baseTime = 120) => {
  if (bidMinutes === undefined || bidMinutes === null || bidMinutes === '') {
    return { isValid: false, error: 'Bid time is required' };
  }

  const numericBid = Number(bidMinutes);

  if (!Number.isInteger(numericBid)) {
    return { isValid: false, error: 'Bid time must be a whole number of minutes' };
  }

  if (numericBid < minBid) {
    return { isValid: false, error: `Minimum allowable bid is ${minBid} minutes` };
  }

  if (numericBid > baseTime) {
    return { isValid: false, error: `Maximum allowable bid is ${baseTime} minutes` };
  }

  return { isValid: true, value: numericBid };
};

/**
 * Validates judge score
 * @param {any} score
 * @returns {{ isValid: boolean, error?: string, value?: number }}
 */
const validateScore = (score) => {
  if (score === undefined || score === null || score === '') {
    return { isValid: false, error: 'Judge score is required' };
  }

  const numericScore = Number(score);

  if (isNaN(numericScore)) {
    return { isValid: false, error: 'Judge score must be a valid number' };
  }

  if (!Number.isInteger(numericScore)) {
    return { isValid: false, error: 'Judge score must be a whole number' };
  }

  if (numericScore < 0 || numericScore > 100) {
    return { isValid: false, error: 'Judge score must be between 0 and 100' };
  }

  return { isValid: true, value: numericScore };
};

/**
 * Validates team creation payload
 * @param {string} teamName
 * @param {string} password
 * @returns {{ isValid: boolean, error?: string }}
 */
const validateTeamInput = (teamName, password) => {
  if (!teamName || typeof teamName !== 'string' || teamName.trim().length === 0) {
    return { isValid: false, error: 'Team name is required' };
  }

  const trimmedName = teamName.trim();
  if (trimmedName.length < 2 || trimmedName.length > 50) {
    return { isValid: false, error: 'Team name must be between 2 and 50 characters' };
  }

  if (!password || typeof password !== 'string' || password.length < 4) {
    return { isValid: false, error: 'Password must be at least 4 characters long' };
  }

  return { isValid: true };
};

/**
 * Validates a password change payload
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {{ isValid: boolean, error?: string }}
 */
const validatePasswordChange = (currentPassword, newPassword) => {
  if (!currentPassword || typeof currentPassword !== 'string') {
    return { isValid: false, error: 'Current password is required' };
  }

  if (!newPassword || typeof newPassword !== 'string') {
    return { isValid: false, error: 'New password is required' };
  }

  if (newPassword.length < 6) {
    return { isValid: false, error: 'New password must be at least 6 characters long' };
  }

  if (newPassword.length > 72) {
    return { isValid: false, error: 'New password cannot exceed 72 characters' };
  }

  if (newPassword === currentPassword) {
    return { isValid: false, error: 'New password must be different from the current one' };
  }

  return { isValid: true };
};

/**
 * Validates prompt creation payload
 * @param {string} title
 * @param {string} description
 * @param {number} displayOrder
 * @returns {{ isValid: boolean, error?: string }}
 */
const validatePromptInput = (title, description, displayOrder) => {
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return { isValid: false, error: 'Prompt title is required' };
  }

  if (title.trim().length > 100) {
    return { isValid: false, error: 'Prompt title cannot exceed 100 characters' };
  }

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    return { isValid: false, error: 'Prompt description is required' };
  }

  if (displayOrder !== undefined) {
    const orderNum = Number(displayOrder);
    if (!Number.isInteger(orderNum) || orderNum < 1) {
      return { isValid: false, error: 'Display order must be a positive integer' };
    }
  }

  return { isValid: true };
};

/**
 * Validates game configuration update payload
 * @param {object} config
 * @returns {{ isValid: boolean, error?: string }}
 */
const validateGameConfig = (config) => {
  if (!config || typeof config !== 'object') {
    return { isValid: false, error: 'Config object is required' };
  }

  if (config.baseTime !== undefined) {
    const baseTime = Number(config.baseTime);
    if (!Number.isInteger(baseTime) || baseTime <= 0) {
      return { isValid: false, error: 'baseTime must be a positive integer' };
    }
  }

  if (config.minBid !== undefined) {
    const minBid = Number(config.minBid);
    if (!Number.isInteger(minBid) || minBid <= 0) {
      return { isValid: false, error: 'minBid must be a positive integer' };
    }
  }

  if (config.maxTeams !== undefined) {
    const maxTeams = Number(config.maxTeams);
    if (!Number.isInteger(maxTeams) || maxTeams < 1 || maxTeams > 50) {
      return { isValid: false, error: 'maxTeams must be between 1 and 50' };
    }
  }

  if (config.slotsPerPrompt !== undefined) {
    const slots = Number(config.slotsPerPrompt);
    if (!Number.isInteger(slots) || slots < 1) {
      return { isValid: false, error: 'slotsPerPrompt must be at least 1' };
    }
  }

  if (config.bidDurationSeconds !== undefined) {
    const duration = Number(config.bidDurationSeconds);
    if (!Number.isInteger(duration) || duration < 10) {
      return { isValid: false, error: 'bidDurationSeconds must be at least 10 seconds' };
    }
  }

  return { isValid: true };
};

module.exports = {
  validateBid,
  validateScore,
  validateTeamInput,
  validatePasswordChange,
  validatePromptInput,
  validateGameConfig
};
