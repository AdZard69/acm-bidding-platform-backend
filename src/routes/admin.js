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

module.exports = router;
