// Cache to prevent hammering the DB. Stores user_id -> timestamp
const activityCache = new Map();

const trackActivity = (req, res, next) => {
  // Let the request continue immediately (non-blocking)
  next();

  if (req.user && req.user.userId && req.db) {
    const userId = req.user.userId;
    const now = Date.now();
    const lastActive = activityCache.get(userId);

    // 1 hour = 60 * 60 * 1000 = 3600000 ms
    if (!lastActive || (now - lastActive) > 3600000) {
      activityCache.set(userId, now);
      
      // Fire-and-forget background query to update the timestamp
      req.db.query('UPDATE users SET last_active_at = NOW() WHERE user_id = $1', [userId])
        .catch(err => console.error('Failed to update last_active_at:', err.message));
    }
  }
};

module.exports = { trackActivity };
