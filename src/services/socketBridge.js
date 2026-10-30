const httpClient = require('../utils/httpClient');
const redis = require('../config/redis');

class SocketBridge {
  async disconnectUser(userId) {
    try {
      if (redis.status === 'ready') {
        await redis.publish('socket:events', JSON.stringify({
          action: 'disconnectUser',
          userId
        }));
      }
      // Also notify Main API via internal HTTP endpoint
      await httpClient.post('/socket/disconnect-user', { userId }).catch(() => {});
    } catch (err) {
      console.warn(`[SocketBridge] Notice: Could not send disconnectUser for ${userId}:`, err.message);
    }
  }

  async broadcastGlobal(event, payload) {
    try {
      if (redis.status === 'ready') {
        await redis.publish('socket:events', JSON.stringify({
          action: 'broadcastGlobal',
          event,
          payload
        }));
      }
      await httpClient.post('/socket/broadcast', { event, payload }).catch(() => {});
    } catch (err) {
      console.warn(`[SocketBridge] Notice: Could not broadcastGlobal:`, err.message);
    }
  }

  async notifyOrg(orgId, event, payload) {
    try {
      if (redis.status === 'ready') {
        await redis.publish('socket:events', JSON.stringify({
          action: 'notifyOrg',
          orgId,
          event,
          payload
        }));
      }
      await httpClient.post('/socket/notify-org', { orgId, event, payload }).catch(() => {});
    } catch (err) {
      console.warn(`[SocketBridge] Notice: Could not notifyOrg:`, err.message);
    }
  }

  async notifyUser(userId, event, payload) {
    try {
      if (redis.status === 'ready') {
        await redis.publish('socket:events', JSON.stringify({
          action: 'notifyUser',
          userId,
          event,
          payload
        }));
      }
      await httpClient.post('/socket/notify-user', { userId, event, payload }).catch(() => {});
    } catch (err) {
      console.warn(`[SocketBridge] Notice: Could not notifyUser for ${userId}:`, err.message);
    }
  }
}

module.exports = new SocketBridge();
