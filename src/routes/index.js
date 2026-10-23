const express = require('express');
const authRoutes = require('./auth');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/admin', require('./admin'));

module.exports = router;
