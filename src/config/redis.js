const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  retryStrategy(times) {
    return Math.min(times * 50, 2000);
  },
  reconnectOnError(err) {
    if (err.message && err.message.includes('READONLY')) {
      return true;
    }
    return false;
  },
});

redis.setEx = async (key, seconds, value) => {
  return redis.set(key, value, 'EX', seconds);
};

let hasLoggedUnavailable = false;

redis.on('connect', () => {
  console.log('✅ Admin Backend: Redis connected');
  hasLoggedUnavailable = false;
});

redis.on('error', (err) => {
  if (err.code === 'ECONNREFUSED') {
    if (!hasLoggedUnavailable) {
      console.warn('⚠️ Admin Backend: Redis unavailable. Running without cache.');
      hasLoggedUnavailable = true;
    }
  } else {
    console.error('❌ Admin Backend Redis error:', err.message);
  }
});

module.exports = redis;
