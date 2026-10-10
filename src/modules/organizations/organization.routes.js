const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const organizationController = require('./organization.controller');

router.get('/', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizations);
router.get('/industries', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationIndustries);
router.get('/verifications/queue', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getVerificationQueue);
router.get('/:id', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationDetails);
router.post('/verifications/documents/:documentId/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewDocument);
router.post('/verifications/:id/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewOrganizationVerification);
router.post('/:id/warn', requireRoles(['Admin', 'Moderator']), organizationController.warnOrganization);
router.post('/:id/suspend', requireRoles(['Admin', 'Moderator']), organizationController.suspendOrganization);
router.post('/:id/unsuspend', requireRoles(['Admin', 'Moderator']), organizationController.unsuspendOrganization);
router.post('/bulk-warn', requireRoles(['Admin', 'Moderator']), organizationController.bulkWarnOrganizations);
router.post('/bulk-suspend', requireRoles(['Admin', 'Moderator']), organizationController.bulkSuspendOrganizations);
router.post('/bulk-unsuspend', requireRoles(['Admin', 'Moderator']), organizationController.bulkUnsuspendOrganizations);
router.post('/bulk-delete', requireRoles(['Admin']), organizationController.bulkDeleteOrganizations);

module.exports = router;
