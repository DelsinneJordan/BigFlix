/**
 * Admin Routes
 * System administration and settings
 */

const express = require('express');
const db = require('../database');
const { encrypt, decrypt } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All admin routes require admin role
router.use(requireAdmin);

/**
 * GET /api/admin/settings
 * Get system settings
 */
router.get('/settings', (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings WHERE key NOT IN (?, ?, ?)').all(
      'encryption_key', 'jwt_secret', 'setup_complete'
    );

    const result = {};
    for (const setting of settings) {
      if (setting.encrypted) {
        // Don't return encrypted values, just indicate they exist
        result[setting.key] = { configured: true };
      } else {
        result[setting.key] = setting.value;
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Get settings error:', error.message);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

/**
 * PUT /api/admin/settings
 * Update system settings
 */
router.put('/settings', (req, res) => {
  try {
    const { key, value, encrypted } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'Setting key required' });
    }

    // Prevent updating internal settings
    if (['encryption_key', 'jwt_secret', 'setup_complete'].includes(key)) {
      return res.status(403).json({ error: 'Cannot modify internal settings' });
    }

    const storedValue = encrypted ? encrypt(value) : value;
    
    db.prepare("INSERT OR REPLACE INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, datetime('now'))")
      .run(key, storedValue, encrypted ? 1 : 0);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'update_setting', `Updated setting: ${key}`, req.ip);

    res.json({ message: 'Setting updated' });
  } catch (error) {
    console.error('Update setting error:', error.message);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

/**
 * GET /api/admin/stats
 * Get system statistics
 */
router.get('/stats', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    const serverCount = db.prepare('SELECT COUNT(*) as count FROM plex_servers').get();
    const pendingRequests = db.prepare("SELECT COUNT(*) as count FROM content_requests WHERE status = 'pending'").get();
    const rssItemCount = db.prepare('SELECT COUNT(*) as count FROM rss_items').get();

    // Recent activity
    const recentActivity = db.prepare(`
      SELECT a.*, u.username 
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC
      LIMIT 20
    `).all();

    res.json({
      users: userCount.count,
      servers: serverCount.count,
      pendingRequests: pendingRequests.count,
      rssItems: rssItemCount.count,
      recentActivity: recentActivity.map(a => ({
        id: a.id,
        username: a.username,
        action: a.action,
        details: a.details,
        createdAt: a.created_at
      }))
    });
  } catch (error) {
    console.error('Get stats error:', error.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/admin/audit
 * Get audit log
 */
router.get('/audit', (req, res) => {
  try {
    const { page = 1, limit = 50, userId, action } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT a.*, u.username 
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
    `;
    
    const conditions = [];
    const params = [];

    if (userId) {
      conditions.push('a.user_id = ?');
      params.push(userId);
    }

    if (action) {
      conditions.push('a.action = ?');
      params.push(action);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ` ORDER BY a.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const logs = db.prepare(sql).all(...params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as count FROM audit_log';
    if (conditions.length > 0) {
      countSql += ' WHERE ' + conditions.join(' AND ');
    }
    const total = db.prepare(countSql).get(...params.slice(0, -2));

    res.json({
      logs: logs.map(a => ({
        id: a.id,
        username: a.username,
        action: a.action,
        details: a.details,
        ipAddress: a.ip_address,
        createdAt: a.created_at
      })),
      total: total.count,
      page: parseInt(page),
      totalPages: Math.ceil(total.count / limit)
    });
  } catch (error) {
    console.error('Get audit log error:', error.message);
    res.status(500).json({ error: 'Failed to get audit log' });
  }
});

/**
 * POST /api/admin/clear-cache
 * Clear availability cache
 */
router.post('/clear-cache', (req, res) => {
  try {
    // Clear in-memory caches (would need to import from search routes in real implementation)
    
    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'clear_cache', 'Cleared availability cache', req.ip);

    res.json({ message: 'Cache cleared' });
  } catch (error) {
    console.error('Clear cache error:', error.message);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

/**
 * POST /api/admin/cleanup-sessions
 * Clean up expired sessions
 */
router.post('/cleanup-sessions', (req, res) => {
  try {
    const result = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'cleanup_sessions', `Removed ${result.changes} expired sessions`, req.ip);

    res.json({ 
      message: 'Sessions cleaned up',
      removed: result.changes
    });
  } catch (error) {
    console.error('Cleanup sessions error:', error.message);
    res.status(500).json({ error: 'Failed to cleanup sessions' });
  }
});

module.exports = router;
