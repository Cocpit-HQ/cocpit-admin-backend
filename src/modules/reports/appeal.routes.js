const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const reportController = require('./report.controller');

router.get('/', requireRoles(['Admin', 'Moderator']), reportController.getAppeals);
router.patch('/:id', requireRoles(['Admin']), reportController.updateAppeal);

module.exports = router;
