const express = require('express');
const bidController = require('../controllers/bidController');
const { requireTeam } = require('../middleware/authTeam');

const router = express.Router();

router.use(requireTeam);

router.get('/current', bidController.getCurrentPrompt);
router.post('/place', bidController.placeBid);
router.put('/update', bidController.updateBid);
router.get('/my-bids', bidController.getMyBids);
router.get('/assignment', bidController.getAssignment);
router.get('/leaderboard', bidController.getLeaderboard);

module.exports = router;
