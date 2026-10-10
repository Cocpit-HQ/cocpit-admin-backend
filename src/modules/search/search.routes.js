const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');
const searchController = require('./search.controller');

router.get('/', requireRoles(['Admin', 'Moderator', 'Developer']), searchController.globalSearch);

module.exports = router;
