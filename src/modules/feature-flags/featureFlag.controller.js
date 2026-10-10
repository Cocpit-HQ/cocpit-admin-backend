const redis = require('../../config/redis');
const socketService = require('../../services/socketBridge');
const { pool } = require('../../config/db');

const getFlags = async (req, res) => {
  try {
    const keys = await redis.keys('feature_flag:*');
    const flags = {};
    for (const key of keys) {
      const val = await redis.get(key);
      const flagKey = key.replace('feature_flag:', '');
      flags[flagKey] = val === 'true';
    }
    res.json({ success: true, data: flags });
  } catch (error) {
    console.error('Error fetching flags:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch flags' });
  }
};

const updateFlag = async (req, res) => {
  try {
    const { key, value, features, flags } = req.body;
    const itemsToUpdate = features || flags || (key !== undefined ? { [key]: value } : null);

    if (!itemsToUpdate || typeof itemsToUpdate !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid payload: key/value or features object required' });
    }

    // Ensure notification flag aliases are kept in sync
    if (itemsToUpdate.enableNotifications !== undefined && itemsToUpdate.enableNotificationsModule === undefined) {
      itemsToUpdate.enableNotificationsModule = itemsToUpdate.enableNotifications;
    } else if (itemsToUpdate.enableNotificationsModule !== undefined && itemsToUpdate.enableNotifications === undefined) {
      itemsToUpdate.enableNotifications = itemsToUpdate.enableNotificationsModule;
    }

    let redisFailed = false;
    const updated = [];
    const broadcastPayload = {};
    for (const [k, v] of Object.entries(itemsToUpdate)) {
      if (v !== undefined && v !== null) {
        const strVal = String(v);
        const boolVal = v === true || v === 'true';

        // Upsert into PostgreSQL DB
        await pool.query(
          `INSERT INTO feature_flags (flag_key, is_enabled, updated_at) 
           VALUES ($1, $2, now()) 
           ON CONFLICT (flag_key) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
          [k, boolVal]
        );

        updated.push({ key: k, value: boolVal });
        broadcastPayload[k] = boolVal;

        try {
          await redis.set(`feature_flag:${k}`, strVal);
          await redis.publish('admin:feature_flags', JSON.stringify({
            action_taken: 'updated',
            key: k,
            value: boolVal
          }));
        } catch (redisErr) {
          console.warn(`⚠️ Redis failed during flag update for ${k}:`, redisErr.message);
          redisFailed = true;
        }
      }
    }
    
    try {
      if (Object.keys(broadcastPayload).length > 0) {
        socketService.broadcastGlobal('feature_flags_updated', broadcastPayload);
      }
    } catch (socketErr) {
      console.warn('⚠️ Socket broadcast failed:', socketErr.message);
      redisFailed = true; // Treating socket failure same as redis failure for warning purposes
    }
    
    if (redisFailed) {
      return res.json({ 
        success: true, 
        message: `${updated.length} flag(s) saved to database, but real-time broadcast failed. Active users may need to refresh.`, 
        data: updated,
        warning: 'Redis or WebSocket failure'
      });
    }

    res.json({ success: true, message: `${updated.length} flag(s) updated successfully`, data: updated });
  } catch (error) {
    console.error('Error updating flag:', error);
    res.status(500).json({ success: false, message: 'Failed to update flag' });
  }
};

module.exports = { getFlags, updateFlag };
