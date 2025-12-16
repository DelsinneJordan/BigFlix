/**
 * Server Management Routes
 * Plex server and Radarr/Sonarr configuration
 */

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../database');
const { encrypt, decrypt } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/servers
 * List servers (filtered by user assignment for non-admins)
 */
router.get('/', (req, res) => {
  try {
    let servers;
    
    if (req.user.role === 'admin') {
      // Admins see all servers
      servers = db.prepare('SELECT * FROM plex_servers ORDER BY name').all();
    } else {
      // Users only see assigned servers
      servers = db.prepare(`
        SELECT ps.* FROM plex_servers ps
        JOIN user_servers us ON ps.id = us.server_id
        WHERE us.user_id = ?
        ORDER BY ps.name
      `).all(req.user.id);
    }

    // Mask sensitive data
    const maskedServers = servers.map(server => ({
      id: server.id,
      name: server.name,
      url: server.url,
      librarySectionId: server.library_section_id,
      hasPlexToken: !!server.token,
      radarrUrl: server.radarr_url,
      hasRadarrApiKey: !!server.radarr_api_key,
      sonarrUrl: server.sonarr_url,
      hasSonarrApiKey: !!server.sonarr_api_key,
      createdAt: server.created_at
    }));

    res.json(maskedServers);
  } catch (error) {
    console.error('List servers error:', error.message);
    res.status(500).json({ error: 'Failed to list servers' });
  }
});

/**
 * POST /api/servers
 * Create a new server (admin only)
 */
router.post('/', requireAdmin, (req, res) => {
  try {
    const { 
      name, 
      url, 
      token, 
      librarySectionId,
      radarrUrl,
      radarrApiKey,
      sonarrUrl,
      sonarrApiKey 
    } = req.body;

    // Validation
    if (!name || !url || !token) {
      return res.status(400).json({ error: 'Server name, URL, and token required' });
    }

    const serverId = crypto.randomUUID();
    
    db.prepare(`
      INSERT INTO plex_servers (id, name, url, token, library_section_id, radarr_url, radarr_api_key, sonarr_url, sonarr_api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      serverId,
      name,
      url,
      encrypt(token),
      librarySectionId || '1',
      radarrUrl || null,
      radarrApiKey ? encrypt(radarrApiKey) : null,
      sonarrUrl || null,
      sonarrApiKey ? encrypt(sonarrApiKey) : null
    );

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'create_server', `Created server: ${name}`, req.ip);

    res.status(201).json({ 
      message: 'Server created successfully',
      serverId 
    });
  } catch (error) {
    console.error('Create server error:', error.message);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

/**
 * POST /api/servers/test
 * Test server connections with provided credentials (no server id required)
 * This route MUST be before /:id routes to avoid param conflict
 */
router.post('/test', requireAdmin, async (req, res) => {
  try {
    const { url, token, radarrUrl, radarrApiKey, sonarrUrl, sonarrApiKey } = req.body;
    
    const results = {
      plex: { success: false },
      radarr: { success: false, configured: false },
      sonarr: { success: false, configured: false }
    };

    // Test Plex
    if (url && token) {
      try {
        const response = await axios.get(`${url}/identity`, {
          headers: { 'X-Plex-Token': token },
          timeout: 10000
        });
        results.plex = {
          success: true,
          serverName: response.data.MediaContainer.friendlyName,
          version: response.data.MediaContainer.version
        };
      } catch (error) {
        results.plex = { success: false, error: error.message };
      }
    }

    // Test Radarr
    if (radarrUrl && radarrApiKey) {
      results.radarr.configured = true;
      try {
        const response = await axios.get(`${radarrUrl}/api/v3/system/status`, {
          headers: { 'X-Api-Key': radarrApiKey },
          timeout: 10000
        });
        results.radarr = {
          success: true,
          configured: true,
          version: response.data.version
        };
      } catch (error) {
        results.radarr = { success: false, configured: true, error: error.message };
      }
    }

    // Test Sonarr
    if (sonarrUrl && sonarrApiKey) {
      results.sonarr.configured = true;
      try {
        const response = await axios.get(`${sonarrUrl}/api/v3/system/status`, {
          headers: { 'X-Api-Key': sonarrApiKey },
          timeout: 10000
        });
        results.sonarr = {
          success: true,
          configured: true,
          version: response.data.version
        };
      } catch (error) {
        results.sonarr = { success: false, configured: true, error: error.message };
      }
    }

    // Overall success
    results.success = results.plex.success;
    
    res.json(results);
  } catch (error) {
    console.error('Test connection error:', error.message);
    res.status(500).json({ error: 'Failed to test connection' });
  }
});

/**
 * GET /api/servers/:id
 * Get server details
 */
router.get('/:id', (req, res) => {
  try {
    // Check access
    if (req.user.role !== 'admin') {
      const hasAccess = req.user.servers.some(s => s.id === req.params.id);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Return full details for admins, masked for users
    if (req.user.role === 'admin') {
      res.json({
        id: server.id,
        name: server.name,
        url: server.url,
        token: decrypt(server.token),
        librarySectionId: server.library_section_id,
        radarrUrl: server.radarr_url,
        radarrApiKey: server.radarr_api_key ? decrypt(server.radarr_api_key) : null,
        sonarrUrl: server.sonarr_url,
        sonarrApiKey: server.sonarr_api_key ? decrypt(server.sonarr_api_key) : null,
        createdAt: server.created_at
      });
    } else {
      res.json({
        id: server.id,
        name: server.name,
        url: server.url,
        librarySectionId: server.library_section_id,
        hasPlexToken: !!server.token,
        radarrUrl: server.radarr_url,
        hasRadarrApiKey: !!server.radarr_api_key,
        sonarrUrl: server.sonarr_url,
        hasSonarrApiKey: !!server.sonarr_api_key
      });
    }
  } catch (error) {
    console.error('Get server error:', error.message);
    res.status(500).json({ error: 'Failed to get server' });
  }
});

/**
 * PUT /api/servers/:id
 * Update server (admin only)
 */
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { 
      name, 
      url, 
      token, 
      librarySectionId,
      radarrUrl,
      radarrApiKey,
      sonarrUrl,
      sonarrApiKey 
    } = req.body;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (url !== undefined) {
      updates.push('url = ?');
      values.push(url);
    }
    if (token !== undefined) {
      updates.push('token = ?');
      values.push(encrypt(token));
    }
    if (librarySectionId !== undefined) {
      updates.push('library_section_id = ?');
      values.push(librarySectionId);
    }
    if (radarrUrl !== undefined) {
      updates.push('radarr_url = ?');
      values.push(radarrUrl || null);
    }
    if (radarrApiKey !== undefined) {
      updates.push('radarr_api_key = ?');
      values.push(radarrApiKey ? encrypt(radarrApiKey) : null);
    }
    if (sonarrUrl !== undefined) {
      updates.push('sonarr_url = ?');
      values.push(sonarrUrl || null);
    }
    if (sonarrApiKey !== undefined) {
      updates.push('sonarr_api_key = ?');
      values.push(sonarrApiKey ? encrypt(sonarrApiKey) : null);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id);
      db.prepare(`UPDATE plex_servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'update_server', `Updated server: ${server.name}`, req.ip);

    res.json({ message: 'Server updated successfully' });
  } catch (error) {
    console.error('Update server error:', error.message);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

/**
 * DELETE /api/servers/:id
 * Delete server (admin only)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    db.prepare('DELETE FROM plex_servers WHERE id = ?').run(req.params.id);

    // Log the action
    db.prepare(`
      INSERT INTO audit_log (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, 'delete_server', `Deleted server: ${server.name}`, req.ip);

    res.json({ message: 'Server deleted successfully' });
  } catch (error) {
    console.error('Delete server error:', error.message);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

/**
 * POST /api/servers/:id/test
 * Test server connections
 */
router.post('/:id/test', requireAdmin, async (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const results = {
      plex: { success: false },
      radarr: { success: false, configured: false },
      sonarr: { success: false, configured: false }
    };

    // Test Plex
    try {
      const plexToken = decrypt(server.token);
      const response = await axios.get(`${server.url}/identity`, {
        headers: { 'X-Plex-Token': plexToken },
        timeout: 10000
      });
      results.plex = {
        success: true,
        serverName: response.data.MediaContainer.friendlyName,
        version: response.data.MediaContainer.version
      };
    } catch (error) {
      results.plex = { success: false, error: error.message };
    }

    // Test Radarr
    if (server.radarr_url && server.radarr_api_key) {
      results.radarr.configured = true;
      try {
        const radarrKey = decrypt(server.radarr_api_key);
        const response = await axios.get(`${server.radarr_url}/api/v3/system/status`, {
          headers: { 'X-Api-Key': radarrKey },
          timeout: 10000
        });
        results.radarr = {
          success: true,
          configured: true,
          version: response.data.version
        };
      } catch (error) {
        results.radarr = { success: false, configured: true, error: error.message };
      }
    }

    // Test Sonarr
    if (server.sonarr_url && server.sonarr_api_key) {
      results.sonarr.configured = true;
      try {
        const sonarrKey = decrypt(server.sonarr_api_key);
        const response = await axios.get(`${server.sonarr_url}/api/v3/system/status`, {
          headers: { 'X-Api-Key': sonarrKey },
          timeout: 10000
        });
        results.sonarr = {
          success: true,
          configured: true,
          version: response.data.version
        };
      } catch (error) {
        results.sonarr = { success: false, configured: true, error: error.message };
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Test server error:', error.message);
    res.status(500).json({ error: 'Failed to test server' });
  }
});

/**
 * GET /api/servers/:id/libraries
 * Get Plex libraries for a server
 */
router.get('/:id/libraries', requireAdmin, async (req, res) => {
  try {
    const server = db.prepare('SELECT * FROM plex_servers WHERE id = ?').get(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const plexToken = decrypt(server.token);
    const response = await axios.get(`${server.url}/library/sections`, {
      headers: { 
        'X-Plex-Token': plexToken,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const libraries = response.data.MediaContainer.Directory.map(lib => ({
      key: lib.key,
      title: lib.title,
      type: lib.type
    }));

    res.json(libraries);
  } catch (error) {
    console.error('Get libraries error:', error.message);
    res.status(500).json({ error: 'Failed to get Plex libraries' });
  }
});

module.exports = router;


module.exports = router;
