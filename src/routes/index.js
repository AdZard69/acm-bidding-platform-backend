const express = require('express');

const authRoutes = require('./auth');
const docsRoutes = require('./docs');
const adminRoutes = require('./admin');
const bidRoutes = require('./bid');
const scoresRoutes = require('./scores');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/bid', bidRoutes);
router.use('/scores', scoresRoutes);
router.use('/', docsRoutes);

module.exports = router;
