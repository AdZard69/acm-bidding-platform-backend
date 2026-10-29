const express = require('express');
const bidController = require('../controllers/bidController');
const { requireTeam } = require('../middleware/authTeam');

const router = express.Router();

// Public / spectator or any team
router.get('/current', bidController.getCurrentBiddingState);
router.get('/leaderboard', bidController.getLeaderboard);

// Team-only endpoints
router.use(requireTeam);
router.post('/place', bidController.placeBid);
router.post('/', bidController.placeBid);
router.put('/update', bidController.updateBid);
router.put('/', bidController.updateBid);
router.get('/my-bids', bidController.getMyBids);
router.get('/assignment', bidController.getMyAssignment);

module.exports = router;
