const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const userController = require('./user.controller');
const reportController = require('../reports/report.controller');

router.get('/roles', requireRoles(['Admin', 'Developer']), userController.getUserRoles);
router.get('/export-marketing-report', requireRoles(['Admin', 'Developer', 'Moderator']), reportController.exportMarketingProfilesReport);
router.get('/', requireRoles(['Admin', 'Developer']), userController.getUsers);
router.get('/:id', requireRoles(['Admin', 'Developer', 'Moderator']), userController.getUserDetails);
router.post('/:id/warn', requireRoles(['Admin', 'Moderator']), userController.warnUser);
router.post('/bulk-warn', requireRoles(['Admin', 'Moderator']), userController.bulkWarnUsers);
router.post('/:id/suspend', requireRoles(['Admin', 'Moderator']), userController.suspendUser);
router.post('/bulk-suspend', requireRoles(['Admin', 'Moderator']), userController.bulkSuspendUsers);
router.post('/:id/unsuspend', requireRoles(['Admin', 'Moderator']), userController.unsuspendUser);
router.post('/bulk-unsuspend', requireRoles(['Admin', 'Moderator']), userController.bulkUnsuspendUsers);
router.get('/:id/thoughts', requireRoles(['Admin', 'Developer', 'Moderator']), userController.getUserThoughts);
router.patch('/:id', requireRoles(['Admin']), userController.updateUser);
router.post('/:id/restore', requireRoles(['Admin']), userController.restoreUser);
router.delete('/:id', requireRoles(['Admin']), userController.deleteUser);
router.post('/bulk-delete', requireRoles(['Admin']), userController.bulkDeleteUsers);

module.exports = router;
