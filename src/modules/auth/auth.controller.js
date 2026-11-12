const { pool: db } = require('../../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const { logAdminActivity } = require('../../utils/auditLogger');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Return generic error for enumeration prevention, but log exact issues internally if needed
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userResult = await req.db.query('SELECT * FROM admin_panel_users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Convert DB role (e.g., 'DEVELOPER') to Title Case (e.g., 'Developer') for the frontend
    const formattedRole = user.role.split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('_');
    const userRoles = [formattedRole];
    
    const allowedRoles = ['Admin', 'Moderator', 'Developer', 'Super_admin', 'SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'SUPPORT', 'DEVELOPER'];
    const hasAccess = userRoles.some(role => allowedRoles.includes(role.toUpperCase()) || allowedRoles.includes(role));

    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied. Authorized personnel only.' });
    }

    const payload = { userId: user.admin_id, roles: userRoles };
    
    const accessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '24h' });

    const tokenHash = hashToken(refreshToken);
    const ipAddress = req.ip || req.socket.remoteAddress || '127.0.0.1';

    await req.db.query(
      `INSERT INTO admin_refresh_tokens (admin_id, token_hash, expires_at) 
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [user.admin_id, tokenHash]
    );

    const isProductionLike = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProductionLike,
      sameSite: isProductionLike ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    res.json({
      message: 'Login successful',
      accessToken,
      user: {
        id: user.admin_id,
        email: user.email,
        roles: userRoles
      }
    });

    // Fire-and-forget audit log
    logAdminActivity(req.db, user.admin_id, 'LOGIN', 'Successful administrator login', ipAddress);

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const refresh = async (req, res) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token provided' });

  try {
    const tokenHash = hashToken(refreshToken);
    const dbTokenResult = await req.db.query('SELECT * FROM admin_refresh_tokens WHERE token_hash = $1', [tokenHash]);
    
    if (dbTokenResult.rows.length === 0) {
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    const dbToken = dbTokenResult.rows[0];

    // Token Reuse Detection
    if (dbToken.is_revoked) {
      console.warn(`Token reuse detected for admin user ${dbToken.admin_id}. Revoking all tokens.`);
      await req.db.query('UPDATE admin_refresh_tokens SET is_revoked = true WHERE admin_id = $1', [dbToken.admin_id]);
      return res.status(403).json({ error: 'Security alert: Token reuse detected. All sessions revoked.' });
    }

    jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, (err, decoded) => {
      if (err) return res.status(403).json({ error: 'Token expired or invalid' });

      const payload = { userId: decoded.userId, roles: decoded.roles };
      const newAccessToken = jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
      res.json({ accessToken: newAccessToken, roles: decoded.roles });
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const logout = async (req, res) => {
  const { refreshToken } = req.cookies;
  if (!refreshToken) return res.status(204).send();

  try {
    const tokenHash = hashToken(refreshToken);
    
    // Get admin_id for logging before revocation
    const dbTokenResult = await req.db.query('SELECT admin_id FROM admin_refresh_tokens WHERE token_hash = $1', [tokenHash]);
    const userId = dbTokenResult.rows[0]?.admin_id;

    await req.db.query('UPDATE admin_refresh_tokens SET is_revoked = true WHERE token_hash = $1', [tokenHash]);
    const isProductionLike = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    res.clearCookie('refreshToken', {
      httpOnly: true,
      sameSite: isProductionLike ? 'none' : 'lax',
      secure: isProductionLike
    });
    res.status(200).json({ message: 'Logged out successfully' });

    if (userId) {
      logAdminActivity(req.db, userId, 'LOGOUT', 'Administrator logged out successfully');
    }
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { login, refresh, logout };
