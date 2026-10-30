const express = require('express');
const { getClockStatus, syncClock } = require('../controllers/clockController');

const router = express.Router();

/**
 * Public routes for server clock and time synchronization
 */
router.get('/', getClockStatus);
router.get('/sync', syncClock);
router.post('/sync', syncClock);

module.exports = router;
