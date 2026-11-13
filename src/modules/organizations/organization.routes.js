const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const organizationController = require('./organization.controller');

// Directory & Meta
router.get('/', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizations);
router.get('/industries', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationIndustries);
router.get('/verifications/queue', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getVerificationQueue);

// Module 1: Company Identity & Core Profile
router.get('/:id', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationDetails);
router.patch('/:id', requireRoles(['Admin', 'Developer']), organizationController.updateOrganizationDetails);
router.post('/:id/submit-verification', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.submitOrganizationVerification);
router.post('/verifications/documents/:documentId/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewDocument);
router.post('/verifications/:id/review', requireRoles(['Admin', 'Moderator']), organizationController.reviewOrganizationVerification);

// Module 2: Jobs & Hiring
router.get('/:id/jobs', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationJobs);
router.patch('/:id/jobs/:jobId/status', requireRoles(['Admin', 'Moderator']), organizationController.moderateOrganizationJob);

// Module 3: People & Team
router.get('/:id/members', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationMembers);
router.delete('/:id/members/:userId', requireRoles(['Admin', 'Moderator']), organizationController.removeOrganizationMember);

// Module 4: Posts & Content
router.get('/:id/posts', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationPosts);
router.patch('/:id/posts/:postId/moderation', requireRoles(['Admin', 'Moderator']), organizationController.moderateOrganizationPost);
router.get('/:id/posts/:postId/comments', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationPostComments);

// Module 5: Company Risk & Fraud Detection
router.get('/:id/risk', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationRisk);
router.post('/:id/risk/investigation-note', requireRoles(['Admin', 'Moderator']), organizationController.addOrganizationInvestigationNote);

// Module 6: Company History & Chronological Timeline
router.get('/:id/timeline', requireRoles(['Admin', 'Moderator', 'Developer']), organizationController.getOrganizationTimeline);

// Module 7: Company Security & Sessions
router.get('/:id/security', requireRoles(['Admin', 'Developer']), organizationController.getOrganizationSecurity);
router.post('/:id/security/revoke-session', requireRoles(['Admin']), organizationController.revokeOrganizationSession);

// Sanctions & Warnings
router.post('/:id/warn', requireRoles(['Admin', 'Moderator']), organizationController.warnOrganization);
router.post('/:id/suspend', requireRoles(['Admin', 'Moderator']), organizationController.suspendOrganization);
router.post('/:id/unsuspend', requireRoles(['Admin', 'Moderator']), organizationController.unsuspendOrganization);

// Bulk Actions
router.post('/bulk-warn', requireRoles(['Admin', 'Moderator']), organizationController.bulkWarnOrganizations);
router.post('/bulk-suspend', requireRoles(['Admin', 'Moderator']), organizationController.bulkSuspendOrganizations);
router.post('/bulk-unsuspend', requireRoles(['Admin', 'Moderator']), organizationController.bulkUnsuspendOrganizations);
router.post('/bulk-delete', requireRoles(['Admin']), organizationController.bulkDeleteOrganizations);

module.exports = router;
