const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const jobController = require('./job.controller');

router.get('/', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.getJobs);
router.get('/:id', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.getJobById);
router.patch('/:id/moderation', requireRoles(['Admin', 'Moderator', 'Developer']), jobController.moderateJob);

module.exports = router;
