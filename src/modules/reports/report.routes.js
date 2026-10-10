const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const reportController = require('./report.controller');

router.get('/reasons', requireRoles(['Admin', 'Moderator']), reportController.getReportReasons);
router.get('/export-user-profiles', requireRoles(['Admin', 'Moderator', 'Developer']), reportController.exportMarketingProfilesReport);
router.get('/export-marketing-report', requireRoles(['Admin', 'Moderator', 'Developer']), reportController.exportMarketingProfilesReport);
router.get('/', requireRoles(['Admin', 'Moderator']), reportController.getReports);
router.patch('/:id', requireRoles(['Admin', 'Moderator']), reportController.updateReport);

module.exports = router;
