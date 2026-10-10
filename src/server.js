const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { pool } = require('./config/db');
require('./config/redis');

const environmentMiddleware = require('./middlewares/environment.middleware');
const { adminGlobalLimiter } = require('./middlewares/rateLimiter');
const errorHandler = require('./middlewares/errorHandler');

const authRoutes = require('./modules/auth/auth.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Dynamic environment middleware attaches req.db to the requested environment pool
app.use(environmentMiddleware);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'cocpit-admin-backend' });
});

// Auth Routes (Login, Refresh, Logout)
app.use('/api/auth', authRoutes);

// Protected Admin Routes
app.use('/api/admin', adminGlobalLimiter, adminRoutes);

// Global Error Handler
app.use(errorHandler);

const PORT = process.env.PORT || 5002;

async function startServer() {
  try {
    const res = await pool.query('SELECT NOW(), current_database(), current_user');
    console.log(`[Admin DB] PostgreSQL connected successfully at ${res.rows[0].now}`);
    console.log(`[Admin DB] Database: ${res.rows[0].current_database} | User: ${res.rows[0].current_user}`);

    // Ensure audit logs table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
          log_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          user_id UUID,
          action_type VARCHAR(100) NOT NULL,
          description TEXT NOT NULL,
          ip_address VARCHAR(45),
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at 
      ON admin_audit_logs(created_at DESC);
    `);

    console.log('[Admin DB] admin_audit_logs table verified.');
  } catch (err) {
    console.error('⚠️ [Admin DB] Database connection warning:', err.message);
  }

  // Windows-friendly binding: do NOT pass '0.0.0.0'
  const server = app.listen(PORT, () => {
    console.log(`🚀 [Cocpit Admin Backend] Running on port ${PORT}`);
  });

  const gracefulShutdown = () => {
    console.log('\n[Admin API] Shutting down gracefully...');
    server.close(async () => {
      try {
        if (pool) {
          await pool.end();
          console.log('[Admin API] Database pool closed.');
        }
      } catch (err) {
        console.error('[Admin API] Error closing DB pool:', err.message);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

startServer();

module.exports = app;
