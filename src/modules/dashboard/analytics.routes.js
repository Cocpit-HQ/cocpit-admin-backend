const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const dashboardController = require('./dashboard.controller');

router.get('/audit-logs/recent', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getRecentAuditLogs);
router.get('/audit-logs', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getAllAuditLogs);
router.get('/engagement-heatmap', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getEngagementHeatmap);
router.get('/cohort-retention', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getCohortRetention);
router.get('/feature-adoption', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getFeatureAdoption);
router.get('/user-demographics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getActiveUserDemographics);
router.get('/networking-health', dashboardController.getNetworkingHealth);
router.get('/total-users-breakdown', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getTotalUsersBreakdown);
router.get('/upcoming-events-breakdown', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getUpcomingEventsBreakdown);

// Event action endpoints
router.post('/events/:id/takedown', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.takedownEvent);
router.post('/events/payouts', requireRoles(['Developer', 'Admin']), dashboardController.processPayouts);
router.post('/events/:id/bulk-refund', requireRoles(['Developer', 'Admin']), dashboardController.bulkRefund);

module.exports = router;
