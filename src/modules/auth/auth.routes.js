const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const { adminAuthLimiter } = require('../../middlewares/rateLimiter');
const { validate } = require('../../middlewares/validate.middleware');
const { loginSchema } = require('../../schemas/admin.schemas');

router.post('/login', 
  adminAuthLimiter,
  validate(loginSchema),
  authController.login
);

router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

module.exports = router;
