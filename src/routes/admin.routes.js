const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');
const { trackActivity } = require('../middlewares/activity.middleware');

router.use(authenticateToken);
router.use(trackActivity);

// Mount modular routes
router.use('/system', require('../modules/system/system.routes'));
router.use('/search', require('../modules/search/search.routes'));
router.use('/dashboard', require('../modules/dashboard/dashboard.routes'));
router.use('/', require('../modules/dashboard/analytics.routes'));
router.use('/users', require('../modules/users/user.routes'));
router.use('/organisations', require('../modules/organizations/organization.routes'));
router.use('/feed', require('../modules/feed/feed.routes'));
router.use('/jobs', require('../modules/jobs/job.routes'));
router.use('/reports', require('../modules/reports/report.routes'));
router.use('/appeals', require('../modules/reports/appeal.routes'));
router.use('/moderation', require('../modules/reports/moderation.routes'));
router.use('/feature-flags', require('../modules/feature-flags/featureFlag.routes'));
router.use('/support', require('../modules/support/support.routes'));

module.exports = router;
