/**
 * Setup Routes
 * First-time setup wizard endpoints
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const { encrypt } = require('../database');
const { generateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/setup/admin
 * Create the first administrator account
 */
router.post('/admin', (req, res) => {
  try {
    const { username, password, email } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if any users exist
    const existingUser = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (existingUser.count > 0) {
      return res.status(403).json({ error: 'Admin account already exists' });
    }

    // Create admin user
    const userId = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(password, 12);

    db.prepare(`
      INSERT INTO users (id, username, password_hash, email, role, can_add_directly)
      VALUES (?, ?, ?, ?, 'admin', 1)
    `).run(userId, username.toLowerCase(), passwordHash, email || null);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(userId, 'setup_admin', 'First admin account created', req.ip);

    res.json({ 
      message: 'Admin account created successfully',
      userId 
    });
  } catch (error) {
    console.error('Setup admin error:', error.message);
    res.status(500).json({ error: 'Failed to create admin account' });
  }
});

/**
 * POST /api/setup/tmdb
 * Configure TMDB API settings
 */
router.post('/tmdb', (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: 'TMDB API key required' });
    }

    // Encrypt and store API key
    const encryptedKey = encrypt(apiKey);
    db.prepare('INSERT OR REPLACE INTO settings (key, value, encrypted) VALUES (?, ?, 1)')
      .run('tmdb_api_key', encryptedKey);

    res.json({ message: 'TMDB API configured successfully' });
  } catch (error) {
    console.error('Setup TMDB error:', error.message);
    res.status(500).json({ error: 'Failed to configure TMDB' });
  }
});

/**
 * POST /api/setup/server
 * Add the first Plex server
 */
router.post('/server', (req, res) => {
  try {
    const { 
      name, 
      plexUrl, 
      plexToken, 
      librarySectionId,
      radarrUrl,
      radarrApiKey,
      sonarrUrl,
      sonarrApiKey 
    } = req.body;

    // Validation
    if (!name || !plexUrl || !plexToken) {
      return res.status(400).json({ error: 'Server name, Plex URL, and token required' });
    }

    // Create server
    const serverId = crypto.randomUUID();
    
    db.prepare(`
      INSERT INTO plex_servers (id, name, url, token, library_section_id, radarr_url, radarr_api_key, sonarr_url, sonarr_api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      serverId,
      name,
      plexUrl,
      encrypt(plexToken),
      librarySectionId || '1',
      radarrUrl || null,
      radarrApiKey ? encrypt(radarrApiKey) : null,
      sonarrUrl || null,
      sonarrApiKey ? encrypt(sonarrApiKey) : null
    );

    // Assign server to the first admin user
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (admin) {
      db.prepare('INSERT INTO user_servers (user_id, server_id) VALUES (?, ?)')
        .run(admin.id, serverId);
      
      // Set as primary server
      db.prepare('UPDATE users SET primary_server_id = ? WHERE id = ?')
        .run(serverId, admin.id);
    }

    res.json({ 
      message: 'Server configured successfully',
      serverId 
    });
  } catch (error) {
    console.error('Setup server error:', error.message);
    res.status(500).json({ error: 'Failed to configure server' });
  }
});

/**
 * POST /api/setup/complete
 * Mark setup as complete
 */
router.post('/complete', (req, res) => {
  try {
    // Verify minimum requirements
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (userCount.count === 0) {
      return res.status(400).json({ error: 'At least one admin account required' });
    }

    const tmdbKey = db.prepare('SELECT value FROM settings WHERE key = ?').get('tmdb_api_key');
    if (!tmdbKey) {
      return res.status(400).json({ error: 'TMDB API key required' });
    }

    // Mark setup as complete
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('setup_complete', 'true');

    // Get the admin user for auto-login
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
    const token = generateToken(admin.id);

    const servers = db.prepare(`
      SELECT ps.id, ps.name FROM plex_servers ps
      JOIN user_servers us ON ps.id = us.server_id
      WHERE us.user_id = ?
    `).all(admin.id);

    res.json({ 
      message: 'Setup complete',
      token,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        canAddDirectly: true,
        primaryServerId: admin.primary_server_id,
        servers
      }
    });
  } catch (error) {
    console.error('Setup complete error:', error.message);
    res.status(500).json({ error: 'Failed to complete setup' });
  }
});

/**
 * POST /api/setup/test-plex
 * Test Plex server connection
 */
router.post('/test-plex', async (req, res) => {
  try {
    const { url, token } = req.body;
    const axios = require('axios');

    const response = await axios.get(`${url}/identity`, {
      headers: { 'X-Plex-Token': token },
      timeout: 10000
    });

    res.json({ 
      success: true,
      serverName: response.data.MediaContainer.friendlyName,
      version: response.data.MediaContainer.version
    });
  } catch (error) {
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * POST /api/setup/test-radarr
 * Test Radarr connection
 */
router.post('/test-radarr', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    const axios = require('axios');

    const response = await axios.get(`${url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });

    res.json({ 
      success: true,
      version: response.data.version
    });
  } catch (error) {
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * POST /api/setup/test-sonarr
 * Test Sonarr connection
 */
router.post('/test-sonarr', async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    const axios = require('axios');

    const response = await axios.get(`${url}/api/v3/system/status`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000
    });

    res.json({ 
      success: true,
      version: response.data.version
    });
  } catch (error) {
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * POST /api/setup/test-tmdb
 * Test TMDB API key
 */
router.post('/test-tmdb', async (req, res) => {
  try {
    const { apiKey } = req.body;
    const axios = require('axios');

    const response = await axios.get(
      `https://api.themoviedb.org/3/configuration?api_key=${apiKey}`,
      { timeout: 10000 }
    );

    res.json({ 
      success: true,
      imageBaseUrl: response.data.images.secure_base_url
    });
  } catch (error) {
    res.status(400).json({ 
      success: false,
      error: error.response?.data?.status_message || error.message 
    });
  }
});

/**
 * POST /api/setup/restore
 * Restore from backup during setup (after admin account is created)
 */
router.post('/restore', (req, res) => {
  try {
    const { backup } = req.body;

    if (!backup || !backup.format || backup.format !== 'bigflix-backup') {
      return res.status(400).json({ error: 'Invalid backup file format' });
    }

    // Check that admin exists (must create admin first)
    const adminUser = db.prepare('SELECT * FROM users WHERE role = ? LIMIT 1').get('admin');
    if (!adminUser) {
      return res.status(400).json({ error: 'Create admin account first before restoring' });
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
      // Import settings (except setup_complete, encryption_key, jwt_secret)
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

      // Assign all servers to admin user
      const servers = db.prepare('SELECT id FROM plex_servers').all();
      const insertUserServer = db.prepare('INSERT OR IGNORE INTO user_servers (user_id, server_id) VALUES (?, ?)');
      for (const server of servers) {
        insertUserServer.run(adminUser.id, server.id);
      }

      // Set primary server for admin if not set
      if (servers.length > 0) {
        db.prepare('UPDATE users SET primary_server_id = ? WHERE id = ? AND primary_server_id IS NULL')
          .run(servers[0].id, adminUser.id);
      }

      // Import RSS items
      if (data.rssItems) {
        const insertRss = db.prepare(`
          INSERT OR IGNORE INTO rss_items (id, type, tmdb_id, title, year, added_by, server_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of data.rssItems) {
          insertRss.run(
            item.id,
            item.type,
            item.tmdbId,
            item.title,
            item.year,
            adminUser.id,
            item.serverId,
            item.createdAt
          );
        }
      }

      // Import content requests
      if (data.requests) {
        const insertRequest = db.prepare(`
          INSERT OR IGNORE INTO content_requests (id, type, tmdb_id, title, year, status, requested_by, server_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const request of data.requests) {
          insertRequest.run(
            request.id,
            request.type,
            request.tmdbId,
            request.title,
            request.year,
            request.status,
            adminUser.id,
            request.serverId,
            request.createdAt
          );
        }
      }

      // Log the restore
      db.prepare(`
        INSERT INTO audit_log (user_id, action, details, ip_address)
        VALUES (?, ?, ?, ?)
      `).run(adminUser.id, 'setup_restore', `Restored from backup: ${data.servers?.length || 0} servers, ${data.rssItems?.length || 0} RSS items`, req.ip);
    });

    transaction();

    // Count what was imported
    const serverCount = db.prepare('SELECT COUNT(*) as count FROM plex_servers').get().count;
    const rssCount = db.prepare('SELECT COUNT(*) as count FROM rss_items').get().count;

    res.json({ 
      message: 'Backup restored successfully',
      imported: {
        servers: serverCount,
        rssItems: rssCount
      }
    });
  } catch (error) {
    console.error('Setup restore error:', error.message);
    res.status(500).json({ error: 'Failed to restore backup: ' + error.message });
  }
});

/**
 * POST /api/setup/restore/preview
 * Preview backup contents during setup
 */
router.post('/restore/preview', (req, res) => {
  try {
    const { backup } = req.body;

    if (!backup || !backup.format || backup.format !== 'bigflix-backup') {
      return res.status(400).json({ error: 'Invalid backup file format' });
    }

    // Decrypt backup data
    const iv = Buffer.from(backup.iv, 'hex');
    const key = Buffer.from(backup.key, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decryptedData = decipher.update(backup.data, 'hex', 'utf8');
    decryptedData += decipher.final('utf8');
    
    const data = JSON.parse(decryptedData);

    res.json({
      valid: true,
      exportDate: backup.exportDate,
      version: backup.version,
      summary: {
        servers: data.servers?.length || 0,
        users: data.users?.length || 0,
        rssItems: data.rssItems?.length || 0,
        requests: data.requests?.length || 0,
        settings: data.settings?.length || 0
      }
    });
  } catch (error) {
    console.error('Preview restore error:', error.message);
    res.status(400).json({ error: 'Failed to read backup file: ' + error.message });
  }
});

module.exports = router;
