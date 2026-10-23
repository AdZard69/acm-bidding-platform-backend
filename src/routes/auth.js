

const express = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { requireTeam } = require('../middleware/authTeam');
const { requireAdmin } = require('../middleware/authAdmin');

const router = express.Router();

// logins
router.post('/team/login', authController.teamLogin);
router.post('/admin/login', authController.adminLogin);

// session helpers
router.get('/me', authenticate, authController.getMe);
router.post('/logout', authenticate, authController.logout);

// password changes
router.post('/team/change-password', requireTeam, authController.changeTeamPassword);
router.post('/admin/change-password', requireAdmin, authController.changeAdminPassword);

module.exports = router;
