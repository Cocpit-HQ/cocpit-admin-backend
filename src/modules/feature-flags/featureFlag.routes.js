const express = require('express');
const router = express.Router();
const featureFlagController = require('./featureFlag.controller');
const { authenticateToken } = require('../../middlewares/auth.middleware');
const { requireRoles } = require('../../middlewares/role.middleware');

router.use(authenticateToken);

// Developers and Admins can view and modify flags
router.get('/', requireRoles(['Developer', 'Admin', 'developer', 'admin']), featureFlagController.getFlags);
router.put('/', requireRoles(['Developer', 'Admin', 'developer', 'admin']), featureFlagController.updateFlag);

module.exports = router;
