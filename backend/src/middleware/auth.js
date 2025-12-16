/**
 * Authentication Middleware
 * JWT-based authentication with session management
 */

const jwt = require('jsonwebtoken');
const db = require('../database');
const crypto = require('crypto');

// Get or create JWT secret
function getJwtSecret() {
  let secret = db.prepare('SELECT value FROM settings WHERE key = ?').get('jwt_secret');
  if (!secret) {
    const newSecret = crypto.randomBytes(64).toString('hex');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jwt_secret', newSecret);
    return newSecret;
  }
  return secret.value;
}

/**
 * Authenticate JWT token
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret);
    
    // Verify session exists and is not expired
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = db.prepare(`
      SELECT s.*, u.username, u.role, u.can_add_directly, u.primary_server_id
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(tokenHash);

    if (!session) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Get user's assigned servers
    const servers = db.prepare(`
      SELECT ps.* FROM plex_servers ps
      JOIN user_servers us ON ps.id = us.server_id
      WHERE us.user_id = ?
    `).all(session.user_id);

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
      canAddDirectly: session.can_add_directly === 1,
      primaryServerId: session.primary_server_id,
      servers: servers
    };

    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
}

/**
 * Optional authentication - doesn't fail if no token
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret);
    
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = db.prepare(`
      SELECT s.*, u.username, u.role, u.can_add_directly, u.primary_server_id
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(tokenHash);

    if (session) {
      const servers = db.prepare(`
        SELECT ps.* FROM plex_servers ps
        JOIN user_servers us ON ps.id = us.server_id
        WHERE us.user_id = ?
      `).all(session.user_id);

      req.user = {
        id: session.user_id,
        username: session.username,
        role: session.role,
        canAddDirectly: session.can_add_directly === 1,
        primaryServerId: session.primary_server_id,
        servers: servers
      };
    } else {
      req.user = null;
    }
  } catch (error) {
    req.user = null;
  }

  next();
}

/**
 * Require admin role
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Generate JWT token and create session
 */
function generateToken(userId) {
  const secret = getJwtSecret();
  const expiresIn = '7d';
  
  const token = jwt.sign({ userId }, secret, { expiresIn });
  
  // Store session
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  
  // Clean up old sessions for this user
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < datetime('now')").run(userId);
  
  // Create new session
  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, userId, tokenHash, expiresAt);
  
  return token;
}

/**
 * Invalidate token/session
 */
function invalidateToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireAdmin,
  generateToken,
  invalidateToken,
  getJwtSecret
};
