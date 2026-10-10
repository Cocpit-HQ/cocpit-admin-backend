const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const reportController = require('./report.controller');

const moderationController = require('./moderation.controller');

router.delete('/posts/:id', requireRoles(['Admin', 'Moderator']), reportController.deleteReportedPost);
router.delete('/comments/:id', requireRoles(['Admin', 'Moderator']), reportController.deleteReportedComment);

// Moderation Appeals
router.get('/appeals', requireRoles(['Admin', 'Moderator']), moderationController.getModerationAppeals);
router.post('/appeals/:id/approve', requireRoles(['Admin']), moderationController.approveAppeal);
router.post('/appeals/:id/reject', requireRoles(['Admin', 'Moderator']), moderationController.rejectAppeal);

module.exports = router;
