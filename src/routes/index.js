const express = require('express');

const authRoutes = require('./auth');
const docsRoutes = require('./docs');
const adminRoutes = require('./admin');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/', docsRoutes);

module.exports = router;
