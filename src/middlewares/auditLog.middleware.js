const { pool } = require('../config/db');

/**
 * Helper to create an audit log entry.
 * @param {string|number} adminId - ID of the admin performing the action
 * @param {string} actionType - e.g., 'ORG_VERIFICATION_VERIFIED'
 * @param {string} description - Human readable description
 */
async function createAuditLog(adminId, actionType, description) {
  try {
    await pool.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, actionType, description]
    );
  } catch (e) {
    console.error('Failed to create audit log:', e.message);
  }
}

module.exports = { createAuditLog };
