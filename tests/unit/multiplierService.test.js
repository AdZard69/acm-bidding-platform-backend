/**
 * Unit tests for multiplierService matching the tables in README.md
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateMultiplier,
  calculateFinalScore,
  getKFactor,
  generateMultiplierTable
} = require('../../src/services/multiplierService');

describe('Multiplier Service Unit Tests', () => {
  it('correct k-factors for rounds', () => {
    assert.equal(getKFactor(1), 1.0);
    assert.equal(getKFactor(2), 0.7);
    assert.equal(getKFactor(3), 1.0); // default
  });

  it('matches Round 1 multiplier table from README (k = 1.0)', () => {
    const expectedRound1 = [
      { bid: 120, multiplier: 1.0 },
      { bid: 110, multiplier: 1.087 },
      { bid: 100, multiplier: 1.181 },
      { bid: 90, multiplier: 1.284 },
      { bid: 80, multiplier: 1.396 },
      { bid: 70, multiplier: 1.517 },
      { bid: 60, multiplier: 1.649 },
      { bid: 50, multiplier: 1.792 },
      { bid: 40, multiplier: 1.948 },
      { bid: 30, multiplier: 2.117 }
    ];

    for (const item of expectedRound1) {
      const result = calculateMultiplier(item.bid, 1, 120, 30);
      assert.equal(result, item.multiplier, `Bid ${item.bid} failed for round 1`);
    }
  });

  it('matches Round 2 multiplier table from README (k = 0.7)', () => {
    const expectedRound2 = [
      { bid: 120, multiplier: 1.0 },
      { bid: 110, multiplier: 1.06 },
      { bid: 100, multiplier: 1.124 },
      { bid: 90, multiplier: 1.191 },
      { bid: 80, multiplier: 1.263 },
      { bid: 70, multiplier: 1.339 },
      { bid: 60, multiplier: 1.419 },
      { bid: 50, multiplier: 1.504 },
      { bid: 40, multiplier: 1.595 },
      { bid: 30, multiplier: 1.69 }
    ];

    for (const item of expectedRound2) {
      const result = calculateMultiplier(item.bid, 2, 120, 30);
      assert.equal(result, item.multiplier, `Bid ${item.bid} failed for round 2`);
    }
  });

  it('calculates final score accurately matching README examples', () => {
    // Team A: judge score 70, multiplier 1.792 -> 125.44
    assert.equal(calculateFinalScore(70, 1.792), 125.44);

    // Team B: judge score 90, multiplier 1.087 -> 97.83
    assert.equal(calculateFinalScore(90, 1.087), 97.83);

    // Team C: judge score 45, multiplier 2.117 -> 95.265 rounded to 95.265 (or ~95.27)
    assert.equal(calculateFinalScore(45, 2.117), 95.265);

    // Round 2 example: judge score 75, multiplier 1.690 -> 126.75
    assert.equal(calculateFinalScore(75, 1.69), 126.75);
  });

  it('generateMultiplierTable generates correct entries', () => {
    const table = generateMultiplierTable(1, 10);
    assert.equal(table.length, 10);
    assert.equal(table[0].bid, 120);
    assert.equal(table[0].multiplier, 1.0);
    assert.equal(table[table.length - 1].bid, 30);
    assert.equal(table[table.length - 1].multiplier, 2.117);
  });
});
