const express = require('express');
const adminController = require('../controllers/adminController');
const { requireAdmin } = require('../middleware/authAdmin');

const router = express.Router();

router.use(requireAdmin);

// teams
router.get('/teams', adminController.listTeams);
router.post('/teams', adminController.createTeam);
router.put('/teams/:id', adminController.updateTeam);
router.delete('/teams/:id', adminController.deleteTeam);
router.patch('/teams/:id/toggle', adminController.toggleTeam);

// prompts
router.get('/prompts', adminController.listPrompts);
router.post('/prompts', adminController.createPrompt);
router.put('/prompts/:id', adminController.updatePrompt);
router.delete('/prompts/:id', adminController.deletePrompt);

// round controls
router.post('/round/start', adminController.startRound);
router.post('/round/pause', adminController.pauseRound);
router.post('/round/resume', adminController.resumeRound);
router.post('/round/extend', adminController.extendRound);
router.post('/round/next-prompt', adminController.nextPrompt);
router.post('/round/end', adminController.endRound);

// scores & leaderboard
router.post('/scores/:teamId', adminController.submitScore);
router.get('/leaderboard', adminController.getLeaderboard);

// reset
router.post('/reset', adminController.resetGame);

// game config
router.get('/config', adminController.getConfig);
router.put('/config', adminController.updateConfig);

module.exports = router;
