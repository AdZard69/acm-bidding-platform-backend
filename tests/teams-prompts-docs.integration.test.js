/**
 * Integration tests for:
 * Team Management:
 *   GET    /api/admin/teams
 *   POST   /api/admin/teams
 *   PUT    /api/admin/teams/:id
 *   DELETE /api/admin/teams/:id
 *   PATCH  /api/admin/teams/:id/toggle
 * Prompt Management:
 *   GET    /api/admin/prompts
 *   POST   /api/admin/prompts
 *   PUT    /api/admin/prompts/:id
 *   DELETE /api/admin/prompts/:id
 * Swagger Docs:
 *   GET    /api/docs
 *   GET    /api/docs.json
 */

const { before, after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { prisma, resetDatabase, createTeam } = require('./helpers/setup');
const { app } = require('../src/server');
const { ensureAdminAccount } = require('../src/services/authService');
const timerManager = require('../src/socket/timerManager');

const ADMIN_PASSWORD = 'admin123';

let server;
let baseUrl;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed, rawText: text, headers: response.headers };
};

const getAdminToken = async () => {
  const res = await api('/api/auth/admin/login', {
    method: 'POST',
    body: { username: 'admin', password: ADMIN_PASSWORD }
  });
  return res.body.token;
};

const getTeamToken = async (teamName, password = 'password123') => {
  await createTeam(teamName, password);
  const res = await api('/api/auth/team/login', {
    method: 'POST',
    body: { teamName, password }
  });
  return res.body.token;
};

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  timerManager.resetTimer();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

beforeEach(async () => {
  timerManager.resetTimer();
  await resetDatabase();
  await ensureAdminAccount();
});

describe('Admin Teams Management', () => {
  describe('GET /api/admin/teams', () => {
    it('rejects without auth token', async () => {
      const res = await api('/api/admin/teams');
      assert.equal(res.status, 401);
    });

    it('rejects with team token', async () => {
      const teamToken = await getTeamToken('Team 1');
      const res = await api('/api/admin/teams', { token: teamToken });
      assert.equal(res.status, 403);
    });

    it('returns empty list when no teams exist', async () => {
      const adminToken = await getAdminToken();
      const res = await api('/api/admin/teams', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.deepEqual(res.body.teams, []);
    });

    it('returns list of teams', async () => {
      const adminToken = await getAdminToken();
      await createTeam('Team Alpha', 'pass123');
      await createTeam('Team Beta', 'pass123');

      const res = await api('/api/admin/teams', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.teams.length, 2);
      assert.equal(res.body.teams[0].teamName, 'Team Alpha');
      assert.equal(res.body.teams[1].teamName, 'Team Beta');
    });
  });

  describe('POST /api/admin/teams', () => {
    it('rejects without auth token', async () => {
      const res = await api('/api/admin/teams', {
        method: 'POST',
        body: { teamName: 'New Team', password: 'password123' }
      });
      assert.equal(res.status, 401);
    });

    it('rejects with team token', async () => {
      const teamToken = await getTeamToken('Team 1');
      const res = await api('/api/admin/teams', {
        method: 'POST',
        token: teamToken,
        body: { teamName: 'New Team', password: 'password123' }
      });
      assert.equal(res.status, 403);
    });

    it('rejects missing or invalid fields', async () => {
      const adminToken = await getAdminToken();

      // Missing teamName
      let res = await api('/api/admin/teams', {
        method: 'POST',
        token: adminToken,
        body: { password: 'password123' }
      });
      assert.equal(res.status, 400);

      // Missing password
      res = await api('/api/admin/teams', {
        method: 'POST',
        token: adminToken,
        body: { teamName: 'Valid Team' }
      });
      assert.equal(res.status, 400);

      // Short password (< 4)
      res = await api('/api/admin/teams', {
        method: 'POST',
        token: adminToken,
        body: { teamName: 'Valid Team', password: '123' }
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /at least 4 characters/i);
    });

    it('rejects duplicate teamName', async () => {
      const adminToken = await getAdminToken();
      await createTeam('DuplicateTeam', 'pass123');

      const res = await api('/api/admin/teams', {
        method: 'POST',
        token: adminToken,
        body: { teamName: 'DuplicateTeam', password: 'pass456' }
      });
      assert.equal(res.status, 409);
      assert.match(res.body.error.message, /already exists/i);
    });

    it('creates team successfully', async () => {
      const adminToken = await getAdminToken();
      const res = await api('/api/admin/teams', {
        method: 'POST',
        token: adminToken,
        body: { teamName: 'Innovators', password: 'pass1234' }
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.team.teamName, 'Innovators');
      assert.equal(res.body.team.isActive, true);

      // Verify DB
      const dbTeam = await prisma.team.findUnique({ where: { teamName: 'Innovators' } });
      assert.ok(dbTeam);
    });
  });

  describe('PUT /api/admin/teams/:id', () => {
    it('rejects invalid teamId', async () => {
      const adminToken = await getAdminToken();
      const res = await api('/api/admin/teams/xyz', {
        method: 'PUT',
        token: adminToken,
        body: { teamName: 'Updated' }
      });
      assert.equal(res.status, 400);
    });

    it('rejects non-existent teamId', async () => {
      const adminToken = await getAdminToken();
      const res = await api('/api/admin/teams/9999', {
        method: 'PUT',
        token: adminToken,
        body: { teamName: 'Updated' }
      });
      assert.equal(res.status, 404);
    });

    it('rejects empty update body', async () => {
      const adminToken = await getAdminToken();
      const team = await createTeam('Team 1', 'pass123');
      const res = await api(`/api/admin/teams/${team.id}`, {
        method: 'PUT',
        token: adminToken,
        body: {}
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /nothing to update/i);
    });

    it('rejects name clash with another team', async () => {
      const adminToken = await getAdminToken();
      const team1 = await createTeam('Team 1', 'pass123');
      const team2 = await createTeam('Team 2', 'pass123');

      const res = await api(`/api/admin/teams/${team2.id}`, {
        method: 'PUT',
        token: adminToken,
        body: { teamName: 'Team 1' }
      });
      assert.equal(res.status, 409);
      assert.match(res.body.error.message, /already exists/i);
    });

    it('updates teamName, password and isActive', async () => {
      const adminToken = await getAdminToken();
      const team = await createTeam('OldName', 'pass123');

      const res = await api(`/api/admin/teams/${team.id}`, {
        method: 'PUT',
        token: adminToken,
        body: {
          teamName: 'NewName',
          password: 'newpassword123',
          isActive: false
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.team.teamName, 'NewName');
      assert.equal(res.body.team.isActive, false);

      const dbTeam = await prisma.team.findUnique({ where: { id: team.id } });
      assert.equal(dbTeam.teamName, 'NewName');
      assert.equal(dbTeam.isActive, false);
    });
  });

  describe('PATCH /api/admin/teams/:id/toggle', () => {
    it('flips team isActive state', async () => {
      const adminToken = await getAdminToken();
      const team = await createTeam('Team To Toggle', 'pass123');
      assert.equal(team.isActive, true);

      // Toggle to false
      let res = await api(`/api/admin/teams/${team.id}/toggle`, {
        method: 'PATCH',
        token: adminToken
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.team.isActive, false);

      // Toggle to true
      res = await api(`/api/admin/teams/${team.id}/toggle`, {
        method: 'PATCH',
        token: adminToken
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.team.isActive, true);
    });
  });

  describe('DELETE /api/admin/teams/:id', () => {
    it('deletes team and cascades relations', async () => {
      const adminToken = await getAdminToken();
      const team = await createTeam('Team To Delete', 'pass123');
      const prompt = await prisma.prompt.create({
        data: { title: 'P1', description: 'D1', displayOrder: 1 }
      });
      await prisma.bid.create({
        data: { teamId: team.id, promptId: prompt.id, bidMinutes: 45, round: 1 }
      });
      await prisma.assignment.create({
        data: { teamId: team.id, promptId: prompt.id, bidMinutes: 45, round: 1, multiplier: 1.868 }
      });
      await prisma.score.create({
        data: { teamId: team.id, judgeScore: 80, multiplier: 1.868, finalScore: 149.44 }
      });

      const res = await api(`/api/admin/teams/${team.id}`, {
        method: 'DELETE',
        token: adminToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Team removed');

      // Verify deletion
      assert.equal(await prisma.team.findUnique({ where: { id: team.id } }), null);
      assert.equal(await prisma.bid.count({ where: { teamId: team.id } }), 0);
      assert.equal(await prisma.assignment.count({ where: { teamId: team.id } }), 0);
      assert.equal(await prisma.score.count({ where: { teamId: team.id } }), 0);
    });
  });
});

describe('Admin Prompts Management', () => {
  describe('GET /api/admin/prompts', () => {
    it('rejects without auth token', async () => {
      const res = await api('/api/admin/prompts');
      assert.equal(res.status, 401);
    });

    it('rejects with team token', async () => {
      const teamToken = await getTeamToken('Team 1');
      const res = await api('/api/admin/prompts', { token: teamToken });
      assert.equal(res.status, 403);
    });

    it('returns prompts ordered by displayOrder asc', async () => {
      const adminToken = await getAdminToken();
      await prisma.prompt.create({
        data: { title: 'Prompt B', description: 'Desc B', displayOrder: 2 }
      });
      await prisma.prompt.create({
        data: { title: 'Prompt A', description: 'Desc A', displayOrder: 1 }
      });

      const res = await api('/api/admin/prompts', { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.prompts.length, 2);
      assert.equal(res.body.prompts[0].title, 'Prompt A');
      assert.equal(res.body.prompts[1].title, 'Prompt B');
    });
  });

  describe('POST /api/admin/prompts', () => {
    it('rejects invalid inputs', async () => {
      const adminToken = await getAdminToken();

      // Missing title
      let res = await api('/api/admin/prompts', {
        method: 'POST',
        token: adminToken,
        body: { description: 'Desc' }
      });
      assert.equal(res.status, 400);

      // Missing description
      res = await api('/api/admin/prompts', {
        method: 'POST',
        token: adminToken,
        body: { title: 'Title' }
      });
      assert.equal(res.status, 400);

      // Title too long (> 100)
      res = await api('/api/admin/prompts', {
        method: 'POST',
        token: adminToken,
        body: { title: 'A'.repeat(101), description: 'Desc' }
      });
      assert.equal(res.status, 400);

      // Invalid displayOrder (< 1)
      res = await api('/api/admin/prompts', {
        method: 'POST',
        token: adminToken,
        body: { title: 'Title', description: 'Desc', displayOrder: 0 }
      });
      assert.equal(res.status, 400);
    });

    it('creates prompt with explicit displayOrder', async () => {
      const adminToken = await getAdminToken();
      const res = await api('/api/admin/prompts', {
        method: 'POST',
        token: adminToken,
        body: { title: 'Custom Prompt', description: 'Custom Description', displayOrder: 5 }
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.prompt.title, 'Custom Prompt');
      assert.equal(res.body.prompt.displayOrder, 5);
    });

    it('auto-assigns displayOrder = max + 1 when omitted', async () => {
      const adminToken = await getAdminToken();
      await prisma.prompt.create({
        data: { title: 'First', description: 'Desc', displayOrder: 3 }
      });

      const res = await api('/api/admin/prompts', {
        method: 'POST',
        token: adminToken,
        body: { title: 'Second', description: 'Desc' }
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.prompt.displayOrder, 4);
    });
  });

  describe('PUT /api/admin/prompts/:id', () => {
    it('rejects invalid id or non-existent id', async () => {
      const adminToken = await getAdminToken();

      let res = await api('/api/admin/prompts/abc', {
        method: 'PUT',
        token: adminToken,
        body: { title: 'New' }
      });
      assert.equal(res.status, 400);

      res = await api('/api/admin/prompts/9999', {
        method: 'PUT',
        token: adminToken,
        body: { title: 'New' }
      });
      assert.equal(res.status, 404);
    });

    it('rejects empty update body', async () => {
      const adminToken = await getAdminToken();
      const prompt = await prisma.prompt.create({
        data: { title: 'P1', description: 'D1', displayOrder: 1 }
      });

      const res = await api(`/api/admin/prompts/${prompt.id}`, {
        method: 'PUT',
        token: adminToken,
        body: {}
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /nothing to update/i);
    });

    it('updates prompt fields successfully', async () => {
      const adminToken = await getAdminToken();
      const prompt = await prisma.prompt.create({
        data: { title: 'Original Title', description: 'Original Desc', displayOrder: 1 }
      });

      const res = await api(`/api/admin/prompts/${prompt.id}`, {
        method: 'PUT',
        token: adminToken,
        body: {
          title: 'Updated Title',
          description: 'Updated Desc',
          displayOrder: 10
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.prompt.title, 'Updated Title');
      assert.equal(res.body.prompt.description, 'Updated Desc');
      assert.equal(res.body.prompt.displayOrder, 10);
    });
  });

  describe('DELETE /api/admin/prompts/:id', () => {
    it('deletes prompt and cascades bids and assignments', async () => {
      const adminToken = await getAdminToken();
      const team = await createTeam('Team 1', 'pass123');
      const prompt = await prisma.prompt.create({
        data: { title: 'To Delete', description: 'D', displayOrder: 1 }
      });
      await prisma.bid.create({
        data: { teamId: team.id, promptId: prompt.id, bidMinutes: 45, round: 1 }
      });
      await prisma.assignment.create({
        data: { teamId: team.id, promptId: prompt.id, bidMinutes: 45, round: 1, multiplier: 1.868 }
      });

      const res = await api(`/api/admin/prompts/${prompt.id}`, {
        method: 'DELETE',
        token: adminToken
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.message, 'Prompt removed');

      assert.equal(await prisma.prompt.findUnique({ where: { id: prompt.id } }), null);
      assert.equal(await prisma.bid.count({ where: { promptId: prompt.id } }), 0);
      assert.equal(await prisma.assignment.count({ where: { promptId: prompt.id } }), 0);
    });
  });
});

describe('Swagger Documentation Endpoints', () => {
  it('GET /api/docs returns Swagger UI HTML', async () => {
    const res = await api('/api/docs');
    assert.equal(res.status, 200);
    assert.match(res.rawText, /swagger/i);
  });

  it('GET /api/docs.json returns OpenAPI JSON specification', async () => {
    const res = await api('/api/docs.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.openapi, '3.0.3');
    assert.ok(res.body.paths['/health']);
    assert.ok(res.body.paths['/admin/teams']);
    assert.ok(res.body.paths['/admin/prompts']);
    assert.ok(res.body.paths['/admin/round/start']);
    assert.ok(res.body.paths['/admin/scores/{teamId}']);
    assert.ok(res.body.paths['/admin/leaderboard']);
    assert.ok(res.body.paths['/admin/reset']);
    assert.ok(res.body.paths['/admin/config']);
  });
});
