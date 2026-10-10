const { pool } = require('../../config/db');

exports.getModerationAppeals = async (req, res) => {
  try {
    const { status = 'PENDING', page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const countQuery = `
      SELECT COUNT(*) 
      FROM moderation_appeals
      WHERE status = $1
    `;
    const countRes = await req.db.query(countQuery, [status]);
    const total = parseInt(countRes.rows[0].count);

    const query = `
      SELECT 
        ma.appeal_id,
        ma.appeal_reason,
        ma.status,
        ma.created_at,
        act.action_type,
        act.reason as action_reason,
        act.duration_days,
        u.user_id,
        u.full_name as user_name,
        u.email as user_email,
        u.avatar_url as user_avatar
      FROM moderation_appeals ma
      JOIN moderation_actions act ON ma.action_id = act.action_id
      JOIN users u ON ma.user_id = u.user_id
      WHERE ma.status = $1
      ORDER BY ma.created_at ASC
      LIMIT $2 OFFSET $3
    `;
    const result = await req.db.query(query, [status, limit, offset]);

    res.json({
      appeals: result.rows,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching moderation appeals:', error);
    res.status(500).json({ error: 'Failed to fetch appeals' });
  }
};

exports.approveAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const adminId = req.user.userId;

    // Start transaction
    await req.db.query('BEGIN');

    // 1. Update appeal status
    const appealRes = await req.db.query(
      `UPDATE moderation_appeals 
       SET status = 'APPROVED', reviewed_by = $1, review_notes = $2, updated_at = NOW() 
       WHERE appeal_id = $3 AND status = 'PENDING'
       RETURNING user_id, action_id`,
      [adminId, notes, id]
    );

    if (appealRes.rowCount === 0) {
      await req.db.query('ROLLBACK');
      return res.status(404).json({ error: 'Appeal not found or already resolved' });
    }

    const { user_id, action_id } = appealRes.rows[0];

    // 2. Insert RESTORE action instead of updating is_active
    await req.db.query(
      `INSERT INTO moderation_actions (target_type, target_id, action_type, reason, performed_by) VALUES ($1, $2, $3, $4, $5)`,
      ['USER', user_id, 'RESTORE', 'Appeal approved by admin', adminId]
    );

    // 3. Unsuspend the user
    await req.db.query(
      `UPDATE users SET is_suspended = false, suspended_until = NULL, moderation_flags = 0 WHERE user_id = $1`,
      [user_id]
    );

    // 4. Log audit
    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'APPEAL_APPROVED', `Approved appeal ${id} and unsuspended user ${user_id}`]
    );

    // 5. Redis cleanup
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL);
    await redis.del(`suspended_user:${user_id}`);
    redis.disconnect();

    await req.db.query('COMMIT');
    res.json({ success: true, message: 'Appeal approved and user unsuspended.' });
  } catch (error) {
    await req.db.query('ROLLBACK');
    console.error('Error approving appeal:', error);
    res.status(500).json({ error: 'Failed to approve appeal' });
  }
};

exports.rejectAppeal = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const adminId = req.user.userId;

    const appealRes = await req.db.query(
      `UPDATE moderation_appeals 
       SET status = 'REJECTED', reviewed_by = $1, review_notes = $2, updated_at = NOW() 
       WHERE appeal_id = $3 AND status = 'PENDING'
       RETURNING user_id`,
      [adminId, notes, id]
    );

    if (appealRes.rowCount === 0) {
      return res.status(404).json({ error: 'Appeal not found or already resolved' });
    }

    await req.db.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'APPEAL_REJECTED', `Rejected appeal ${id} for user ${appealRes.rows[0].user_id}`]
    );

    res.json({ success: true, message: 'Appeal rejected.' });
  } catch (error) {
    console.error('Error rejecting appeal:', error);
    res.status(500).json({ error: 'Failed to reject appeal' });
  }
};
