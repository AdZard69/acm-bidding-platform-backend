process.env.NODE_ENV = 'test';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryPrisma } = require('../helpers/memoryPrisma');
const database = createMemoryPrisma();
const prismaPath = require.resolve('../../src/config/prisma');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: database };

const submissionService = require('../../src/services/submissionService');
const GAME_STATUS = require('../../src/constants/gameStatus');

beforeEach(async () => {
  database.reset();
  await database.gameConfig.create({
    data: {
      id: 1,
      status: GAME_STATUS.WAITING,
      baseTime: 120,
      minBid: 30,
      biddingState: {}
    }
  });
  await database.team.create({
    data: { id: 1, teamName: 'Team One', password: 'hash', isActive: true }
  });
  await database.prompt.create({
    data: { id: 1, title: 'Prompt 1', description: 'Description 1', displayOrder: 1 }
  });
});

test('validateGithubUrl accepts valid repo urls and rejects invalid formats', () => {
  const validUrls = [
    'https://github.com/facebook/react',
    'https://www.github.com/vercel/next.js',
    'http://github.com/my-org/my_repo-123',
    'https://github.com/user/repo/tree/main'
  ];
  for (const url of validUrls) {
    assert.equal(submissionService.validateGithubUrl(url), url.trim());
  }

  const invalidUrls = [
    '',
    '   ',
    null,
    123,
    'https://gitlab.com/user/repo',
    'https://google.com',
    'https://github.com/',
    'https://github.com/user',
    'ftp://github.com/user/repo'
  ];
  for (const invalid of invalidUrls) {
    assert.throws(() => submissionService.validateGithubUrl(invalid));
  }
});

test('submitting without an assignment is rejected', async () => {
  await assert.rejects(
    () => submissionService.submitProject(1, 'https://github.com/team/repo'),
    /does not have an assigned problem statement/
  );
});

test('submitting before coding has started is rejected', async () => {
  await database.assignment.create({
    data: { teamId: 1, promptId: 1, bidMinutes: 45, round: 1, multiplier: 1.8 }
  });
  await assert.rejects(
    () => submissionService.submitProject(1, 'https://github.com/team/repo'),
    /Coding phase has not started yet/
  );
});

test('submitting while coding phase is paused is rejected', async () => {
  await database.assignment.create({
    data: { teamId: 1, promptId: 1, bidMinutes: 45, round: 1, multiplier: 1.8 }
  });
  await submissionService.startCodingTimers();
  await submissionService.pauseCodingTimers();

  await assert.rejects(
    () => submissionService.submitProject(1, 'https://github.com/team/repo'),
    /Coding phase is currently paused/
  );
});

test('submitting within time commits the URL and updates existing submission on re-submit', async () => {
  await database.assignment.create({
    data: { teamId: 1, promptId: 1, bidMinutes: 45, round: 1, multiplier: 1.8 }
  });
  await submissionService.startCodingTimers();

  const result = await submissionService.submitProject(1, 'https://github.com/team/repo');
  assert.equal(result.success, true);
  assert.equal(result.submission.githubUrl, 'https://github.com/team/repo');

  const update = await submissionService.submitProject(1, 'https://github.com/team/new-repo');
  assert.equal(update.success, true);
  assert.equal(update.submission.githubUrl, 'https://github.com/team/new-repo');
  assert.equal(database.tables.submissions.length, 1);
});

test('submitting after deadline has passed is rejected', async () => {
  await database.assignment.create({
    data: { teamId: 1, promptId: 1, bidMinutes: 45, round: 1, multiplier: 1.8 }
  });

  // Start coding 50 minutes ago (bid was 45 mins)
  const fiftyMinutesAgo = Date.now() - 50 * 60 * 1000;
  await database.gameConfig.update({
    where: { id: 1 },
    data: {
      status: GAME_STATUS.CODING,
      biddingState: {
        coding: {
          startTime: fiftyMinutesAgo,
          isPaused: false,
          pausedAt: null
        }
      }
    }
  });

  await assert.rejects(
    () => submissionService.submitProject(1, 'https://github.com/team/repo'),
    /Coding time expired/
  );
});

test('getMySubmission and listAllSubmissions report accurate timing and deadline details', async () => {
  await database.assignment.create({
    data: { teamId: 1, promptId: 1, bidMinutes: 45, round: 1, multiplier: 1.8 }
  });
  await submissionService.startCodingTimers();
  await submissionService.submitProject(1, 'https://github.com/team/repo');

  const my = await submissionService.getMySubmission(1);
  assert.equal(my.success, true);
  assert.equal(my.submission.githubUrl, 'https://github.com/team/repo');
  assert.equal(my.assignment.bidMinutes, 45);
  assert.ok(my.codingState.remainingSeconds > 0);
  assert.equal(my.codingState.isExpired, false);

  const all = await submissionService.listAllSubmissions();
  assert.equal(all.success, true);
  assert.equal(all.submissions.length, 1);
  assert.equal(all.submissions[0].isSubmitted, true);
  assert.equal(all.submissions[0].isExpired, false);
});


test('admin submissions includes every registered team, including inactive teams with submissions', async () => {
  await database.team.create({ data: { id: 2, teamName: 'Inactive Team', isActive: false } });
  await database.assignment.create({ data: { teamId: 2, promptId: 1, round: 1, bidMinutes: 45, multiplier: 1.5 } });
  await database.submission.create({ data: { teamId: 2, githubUrl: 'https://github.com/team/project', submittedAt: new Date() } });
  const result = await submissionService.listAllSubmissions();
  assert.equal(result.submissions.length, 2);
  assert.equal(result.submissions.filter((row) => row.isSubmitted).length, 1);
  assert.equal(result.submissions.find((row) => row.teamId === 2).assignment.promptId, 1);
});
