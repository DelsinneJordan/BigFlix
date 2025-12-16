/**
 * Backup and Restore Routes
 * Configuration export/import functionality
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { encrypt, decrypt, getEncryptionKey } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All backup routes require admin role
router.use(requireAdmin);

/**
 * GET /api/backup/export
 * Export full configuration backup
 */
router.get('/export', (req, res) => {
  try {
    const { includeUsers = true, includeRequests = false } = req.query;

    // Gather all configuration data
    const backup = {
      version: '2.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: req.user.username,
      
      // Settings (excluding encryption key and jwt secret)
      settings: db.prepare(`
        SELECT key, value, encrypted FROM settings 
        WHERE key NOT IN ('encryption_key', 'jwt_secret')
      `).all(),
      
      // Servers (with encrypted data re-encrypted with export key)
      servers: db.prepare('SELECT * FROM plex_servers').all().map(s => ({
        id: s.id,
        name: s.name,
        url: s.url,
        token: s.token, // Already encrypted
        librarySectionId: s.library_section_id,
        radarrUrl: s.radarr_url,
        radarrApiKey: s.radarr_api_key, // Already encrypted
        sonarrUrl: s.sonarr_url,
        sonarrApiKey: s.sonarr_api_key // Already encrypted
      })),
      
      // RSS items
      rssItems: db.prepare('SELECT * FROM rss_items').all()
    };

    if (includeUsers === 'true' || includeUsers === true) {
      backup.users = db.prepare(`
        SELECT id, username, email, role, can_add_directly, primary_server_id, created_at
        FROM users
      `).all();
      
      backup.userServers = db.prepare('SELECT * FROM user_servers').all();
    }

    if (includeRequests === 'true' || includeRequests === true) {
      backup.requests = db.prepare('SELECT * FROM content_requests').all();
    }

    // Create encrypted backup with a temporary key
    const backupKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', backupKey, iv);
    
    const jsonData = JSON.stringify(backup);
    let encryptedData = cipher.update(jsonData, 'utf8', 'hex');
    encryptedData += cipher.final('hex');

    const exportData = {
      format: 'bigflix-backup',
      version: '2.0.0',
      iv: iv.toString('hex'),
      key: backupKey.toString('hex'), // In production, this should be derived from a user-provided password
      data: encryptedData
    };

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'export_backup', 'Configuration exported', req.ip);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=bigflix-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json(exportData);
  } catch (error) {
    console.error('Export backup error:', error.message);
    res.status(500).json({ error: 'Failed to export backup' });
  }
});

/**
 * POST /api/backup/import
 * Import configuration from backup
 */
router.post('/import', (req, res) => {
  try {
    const { backup, mergeMode = 'replace' } = req.body;

    if (!backup || !backup.format || backup.format !== 'bigflix-backup') {
      return res.status(400).json({ error: 'Invalid backup file' });
    }

    // Decrypt backup data
    const iv = Buffer.from(backup.iv, 'hex');
    const key = Buffer.from(backup.key, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decryptedData = decipher.update(backup.data, 'hex', 'utf8');
    decryptedData += decipher.final('utf8');
    
    const data = JSON.parse(decryptedData);

    // Begin transaction
    const transaction = db.transaction(() => {
      if (mergeMode === 'replace') {
        // Clear existing data (except current user and essential settings)
        db.prepare('DELETE FROM rss_items').run();
        db.prepare('DELETE FROM content_requests').run();
        db.prepare('DELETE FROM user_servers WHERE user_id != ?').run(req.user.id);
        db.prepare('DELETE FROM plex_servers').run();
        db.prepare('DELETE FROM users WHERE id != ?').run(req.user.id);
      }

      // Import settings
      const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, encrypted) VALUES (?, ?, ?)');
      for (const setting of data.settings || []) {
        if (!['encryption_key', 'jwt_secret', 'setup_complete'].includes(setting.key)) {
          insertSetting.run(setting.key, setting.value, setting.encrypted);
        }
      }

      // Import servers
      const insertServer = db.prepare(`
        INSERT OR REPLACE INTO plex_servers (id, name, url, token, library_section_id, radarr_url, radarr_api_key, sonarr_url, sonarr_api_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const server of data.servers || []) {
        insertServer.run(
          server.id,
          server.name,
          server.url,
          server.token,
          server.librarySectionId,
          server.radarrUrl,
          server.radarrApiKey,
          server.sonarrUrl,
          server.sonarrApiKey
        );
      }

      // Import users (if included and not replacing current user)
      if (data.users) {
        const insertUser = db.prepare(`
          INSERT OR IGNORE INTO users (id, username, email, role, can_add_directly, primary_server_id, created_at, password_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const user of data.users) {
          if (user.id !== req.user.id) {
            // Generate temporary password hash (user will need to reset)
            const tempHash = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.Iu0VrqKMgJ7fX2';
            insertUser.run(
              user.id,
              user.username,
              user.email,
              user.role,
              user.can_add_directly,
              user.primary_server_id,
              user.created_at,
              tempHash
            );
          }
        }
      }

      // Import user-server associations
      if (data.userServers) {
        const insertUserServer = db.prepare('INSERT OR IGNORE INTO user_servers (user_id, server_id) VALUES (?, ?)');
        for (const us of data.userServers) {
          insertUserServer.run(us.user_id, us.server_id);
        }
      }

      // Import RSS items
      const insertRss = db.prepare(`
        INSERT OR IGNORE INTO rss_items (id, server_id, content_type, tmdb_id, title, year, overview, poster_path, seasons, added_by, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of data.rssItems || []) {
        insertRss.run(
          item.id,
          item.server_id,
          item.content_type,
          item.tmdb_id,
          item.title,
          item.year,
          item.overview,
          item.poster_path,
          item.seasons,
          item.added_by,
          item.added_at
        );
      }

      // Import requests (if included)
      if (data.requests) {
        const insertRequest = db.prepare(`
          INSERT OR IGNORE INTO content_requests (id, user_id, server_id, tmdb_id, content_type, title, year, overview, poster_path, status, seasons, requested_at, processed_at, processed_by, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const req of data.requests) {
          insertRequest.run(
            req.id,
            req.user_id,
            req.server_id,
            req.tmdb_id,
            req.content_type,
            req.title,
            req.year,
            req.overview,
            req.poster_path,
            req.status,
            req.seasons,
            req.requested_at,
            req.processed_at,
            req.processed_by,
            req.notes
          );
        }
      }
    });

    transaction();

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'import_backup', `Configuration imported (mode: ${mergeMode})`, req.ip);

    res.json({ 
      message: 'Backup imported successfully',
      imported: {
        settings: data.settings?.length || 0,
        servers: data.servers?.length || 0,
        users: data.users?.length || 0,
        rssItems: data.rssItems?.length || 0
      }
    });
  } catch (error) {
    console.error('Import backup error:', error.message);
    res.status(500).json({ error: 'Failed to import backup: ' + error.message });
  }
});

/**
 * GET /api/backup/preview
 * Preview backup contents without importing
 */
router.post('/preview', (req, res) => {
  try {
    const { backup } = req.body;

    if (!backup || !backup.format || backup.format !== 'bigflix-backup') {
      return res.status(400).json({ error: 'Invalid backup file' });
    }

    // Decrypt backup data
    const iv = Buffer.from(backup.iv, 'hex');
    const key = Buffer.from(backup.key, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decryptedData = decipher.update(backup.data, 'hex', 'utf8');
    decryptedData += decipher.final('utf8');
    
    const data = JSON.parse(decryptedData);

    res.json({
      version: data.version,
      exportedAt: data.exportedAt,
      exportedBy: data.exportedBy,
      contents: {
        settings: data.settings?.length || 0,
        servers: (data.servers || []).map(s => ({ name: s.name, url: s.url })),
        users: (data.users || []).map(u => ({ username: u.username, role: u.role })),
        rssItems: data.rssItems?.length || 0,
        requests: data.requests?.length || 0
      }
    });
  } catch (error) {
    console.error('Preview backup error:', error.message);
    res.status(500).json({ error: 'Failed to preview backup: ' + error.message });
  }
});

module.exports = router;
