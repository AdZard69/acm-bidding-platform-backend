/**
 * Password hashing helpers.
 * Teams and admins authenticate with plain text passwords that are stored
 * as bcrypt hashes in the database. Never store or log plain text passwords.
 */

const bcrypt = require('bcryptjs');
const env = require('../config/env');

/**
 * Hashes a plain text password with bcrypt
 * @param {string} plainPassword
 * @returns {Promise<string>} bcrypt hash
 */
const hashPassword = async (plainPassword) => {
  if (typeof plainPassword !== 'string' || plainPassword.length === 0) {
    throw new Error('Password is required');
  }

  const salt = await bcrypt.genSalt(env.BCRYPT_SALT_ROUNDS);
  return bcrypt.hash(plainPassword, salt);
};

/**
 * Compares a plain text password against a stored bcrypt hash
 * @param {string} plainPassword
 * @param {string} hashedPassword
 * @returns {Promise<boolean>}
 */
const verifyPassword = async (plainPassword, hashedPassword) => {
  if (typeof plainPassword !== 'string' || typeof hashedPassword !== 'string') {
    return false;
  }

  return bcrypt.compare(plainPassword, hashedPassword);
};

module.exports = {
  hashPassword,
  verifyPassword
};
