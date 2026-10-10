const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const dashboardController = require('./dashboard.controller');

router.get('/system-metrics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSystemMetrics);
router.get('/deployments', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDeployments);
router.get('/slow-queries', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSlowQueries);
router.get('/background-tasks', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getBackgroundTasks);
router.get('/system-alerts', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSystemAlerts);
router.get('/metrics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDashboardMetrics);
router.get('/organization-stats', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationStats);
router.get('/user-velocity', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getUserVelocity);
router.get('/demographic-momentum', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDemographicMomentum);
router.get('/live-signups', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getLiveSignups);
router.get('/regional-hotspots', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getRegionalHotspots);
router.get('/internal-spread-metric', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getInternalSpreadMetric);
router.get('/organization-demographics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationDemographics);
router.get('/seat-utilization', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getSeatUtilization);
router.get('/b2b-activity', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getB2BActivity);
router.get('/organization-growth', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getOrganizationGrowthBreakdown);
router.get('/jobs-metrics', requireRoles(['Developer', 'Admin', 'Moderator']), dashboardController.getJobsMetrics);
router.get('/ai-analytics', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getAiAnalytics);
router.get('/notifications', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getAdminNotifications);
router.get('/daily-signups', requireRoles(['Admin', 'Moderator', 'Developer']), dashboardController.getDailySignups);

module.exports = router;
