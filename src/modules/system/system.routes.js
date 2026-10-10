const express = require('express');
const router = express.Router();
const { requireRoles } = require('../../middlewares/role.middleware');

router.get('/controls', requireRoles(['Developer']), (req, res) => {
  res.json({ message: 'System Controls Data (Read)' });
});

router.post('/controls', requireRoles(['Developer']), (req, res) => {
  res.json({ message: 'System Controls Settings Updated (Write)' });
});

router.get('/health', requireRoles(['Developer', 'Admin', 'Moderator']), (req, res) => {
  res.json({ message: 'System Health Metrics' });
});

module.exports = router;
