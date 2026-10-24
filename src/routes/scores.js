const express = require('express');
const scoreController = require('../controllers/scoreController');
const { requireAdmin } = require('../middleware/authAdmin');

const router = express.Router();

router.use(requireAdmin);

router.post('/:teamId', scoreController.submitScore);
router.get('/leaderboard', scoreController.getLeaderboard);

module.exports = router;
